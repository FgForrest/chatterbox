"use client";

import {
    CalendarClock,
    ChevronDown,
    ChevronRight,
    FolderPlus,
    History,
    MoreHorizontal,
    PanelLeftClose,
    Search,
    Settings,
    UserPlus,
    Users,
    X,
} from "lucide-react";
import { useExtracted } from "next-intl";
import { type DragEvent, useEffect, useMemo, useState } from "react";
import {
    ReceivedFolderDialog,
    ReceivedFolderMenu,
} from "@/components/sharing/folder-sharing";
import {
    PersonShareDialog,
    usePersonSharing,
} from "@/components/sharing/person-sharing";
import { SharedFolderIcon } from "@/components/sharing/shared-folder-icon";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "@/components/ui/tooltip";
import { useFolderLabel } from "@/hooks/use-folder-label";
import { useLibraryPreferences } from "@/hooks/use-library-preferences";
import {
    FOLDER_DRAG_TYPE,
    RECORDING_DRAG_TYPE,
    RECORDING_SOURCE_FOLDER_DRAG_TYPE,
    recordingDropEffect,
} from "@/lib/folders/drag";
import { ancestorFolderIds } from "@/lib/folders/hierarchy";
import {
    type FolderNavigation,
    libraryNavigation,
    matchFolderEntries,
    visibleFolderLevel,
} from "@/lib/folders/navigation";
import { canCreateSubfolder } from "@/lib/folders/permissions";
import { cn } from "@/lib/utils";
import type {
    RecordingFolder,
    RecordingFolderAssignment,
} from "@/types/folder";
import type { Recording } from "@/types/recording";

type DropPlacement = "before" | "inside" | "after";

interface DropTarget {
    folderId: string;
    placement: DropPlacement;
}

interface FolderTreeProps {
    folders: RecordingFolder[];
    assignments: RecordingFolderAssignment[];
    recordings: Recording[];
    selectedFolderId: string | null;
    onRecent: () => void;
    onSelectFolder: (folder: RecordingFolder) => void;
    onMoveFolder: (
        folderId: string,
        parentId: string,
        beforeId?: string | null,
    ) => Promise<void>;
    onAssignRecording: (recordingId: string, folderId: string) => Promise<void>;

    onMoveRecording?: (
        recordingId: string,
        fromFolderId: string,
        toFolderId: string,
    ) => Promise<void>;
    onNewFolder?: () => void;
    onPrepareMeeting?: (folder: RecordingFolder) => void;
    canCurate?: boolean;
    isOrgAccount?: boolean;
    onSettings: (folder: RecordingFolder, action?: "create") => void;
    navigation?: FolderNavigation;
    recentCount?: number;
    onCollapse?: () => void;
}

export function FolderTree({
    folders,
    assignments,
    recordings,
    selectedFolderId,
    onRecent,
    onSelectFolder,
    onMoveFolder,
    onAssignRecording,
    onMoveRecording,
    onNewFolder,
    onPrepareMeeting,
    canCurate = false,
    isOrgAccount = false,
    onSettings,
    navigation,
    recentCount,
    onCollapse,
}: FolderTreeProps) {
    const i18n = useExtracted();
    const sharingEnabled = usePersonSharing();
    const [sharingFolder, setSharingFolder] = useState<RecordingFolder | null>(
        null,
    );
    const [attachmentEdit, setAttachmentEdit] = useState<{
        folder: RecordingFolder;
        action: "rename" | "move";
    } | null>(null);
    const folderLabel = useFolderLabel();
    const [isMac, setIsMac] = useState(false);
    useEffect(() => setIsMac(/Mac|iPhone|iPad/.test(navigator.platform)), []);
    const { ready, preferences, setPreferences, recentFolders } =
        useLibraryPreferences();
    const [allLevels, setAllLevels] = useState<Set<string>>(new Set());
    const data = useMemo(
        () =>
            navigation ??
            libraryNavigation(folders, assignments, recordings, folderLabel),
        [navigation, folders, assignments, recordings, folderLabel],
    );
    const activity = data.activity;
    const countByFolder = data.counts;
    const byId = useMemo(
        () => new Map(folders.map((folder) => [folder.id, folder])),
        [folders],
    );
    const currentPath = useMemo(
        () =>
            selectedFolderId
                ? ancestorFolderIds(folders, selectedFolderId, byId)
                : new Set<string>(),
        [folders, selectedFolderId, byId],
    );
    const [query, setQuery] = useState("");
    const [menuFolderId, setMenuFolderId] = useState<string | null>(null);
    const [expanded, setExpanded] = useState(
        () =>
            new Set(
                folders
                    .filter((folder) => folder.parentId === null)
                    .map((folder) => folder.id),
            ),
    );
    const [draggedFolderId, setDraggedFolderId] = useState<string | null>(null);
    const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
    const [recordingDropFolderId, setRecordingDropFolderId] = useState<
        string | null
    >(null);

    const childrenByParent = useMemo(() => {
        const result = new Map<string | null, RecordingFolder[]>();
        for (const folder of folders) {
            const children = result.get(folder.parentId) ?? [];
            children.push(folder);
            result.set(folder.parentId, children);
        }
        for (const children of result.values()) {
            children.sort((left, right) => {
                const rootOrder = { private: 0, public: 1, custom: 2 };
                const kindDiff = rootOrder[left.kind] - rootOrder[right.kind];
                return (
                    kindDiff ||
                    left.sortOrder - right.sortOrder ||
                    left.name.localeCompare(right.name)
                );
            });
        }
        return result;
    }, [folders]);

    useEffect(() => {
        if (preferences.expanded) setExpanded(new Set(preferences.expanded));
    }, [preferences.expanded]);
    useEffect(() => {
        if (!ready || currentPath.size === 0) return;
        setExpanded((value) => new Set([...value, ...currentPath]));
        setPreferences((value) => ({
            ...value,
            expanded: [
                ...new Set([
                    ...(value.expanded ??
                        folders
                            .filter((folder) => folder.parentId === null)
                            .map((folder) => folder.id)),
                    ...currentPath,
                ]),
            ],
        }));
    }, [ready, currentPath, folders, setPreferences]);
    const matchingIds = useMemo(() => {
        if (!query.trim()) return null;
        const result = new Set<string>();
        for (const { folder } of matchFolderEntries(
            data.entries,
            query,
            folderLabel,
        )) {
            for (const id of ancestorFolderIds(folders, folder.id, byId))
                result.add(id);
        }
        return result;
    }, [data.entries, folderLabel, folders, byId, query]);

    const dropPlacementFor = (
        event: DragEvent<HTMLButtonElement>,
        target: RecordingFolder,
    ): DropPlacement => {
        const dragged = folders.find((folder) => folder.id === draggedFolderId);
        if (!dragged || target.kind !== "custom") return "inside";
        if (dragged.scope !== target.scope) return "inside";
        const bounds = event.currentTarget.getBoundingClientRect();
        const position = (event.clientY - bounds.top) / bounds.height;
        if (dragged.parentId === target.parentId) {
            return position < 0.5 ? "before" : "after";
        }
        if (position < 0.25) return "before";
        if (position > 0.75) return "after";
        return "inside";
    };

    const canDropFolderOn = (
        draggedId: string,
        target: RecordingFolder,
    ): boolean => {
        const dragged = folders.find((folder) => folder.id === draggedId);
        if (
            !dragged ||
            dragged.receivedFolder ||
            target.receivedFolder ||
            dragged.scope !== target.scope
        )
            return false;
        return dragged.scope !== "org" || canCurate;
    };

    const dropFolder = (
        draggedId: string,
        target: RecordingFolder,
        placement: DropPlacement,
    ) => {
        if (draggedId === target.id) return;
        // A folder never changes tree: Private folders are nobody else's
        // business and Organization folders are nobody's to take private.
        if (!canDropFolderOn(draggedId, target)) return;
        if (placement === "inside") {
            void onMoveFolder(draggedId, target.id, null).catch(() => {});
            return;
        }
        if (!target.parentId) return;
        const siblings = (childrenByParent.get(target.parentId) ?? []).filter(
            (folder) => folder.id !== draggedId,
        );
        const targetIndex = siblings.findIndex(
            (folder) => folder.id === target.id,
        );
        if (targetIndex < 0) return;
        const beforeId =
            placement === "before"
                ? target.id
                : (siblings[targetIndex + 1]?.id ?? null);
        void onMoveFolder(draggedId, target.parentId, beforeId).catch(() => {});
    };

    const renderFolder = (folder: RecordingFolder, depth: number) => {
        if (matchingIds && !matchingIds.has(folder.id)) return null;
        const children = childrenByParent.get(folder.id) ?? [];
        const isExpanded = !!query.trim() || expanded.has(folder.id);
        const canExpand = children.length > 0;
        const canManage = folder.scope !== "org" || canCurate;
        return (
            <div key={folder.id}>
                {/* biome-ignore lint/a11y/useSemanticElements: Folder row controls are not form inputs. */}
                <div
                    role="group"
                    aria-label={folderLabel(folder)}
                    className={cn(
                        "group/folder flex items-center rounded-md border border-transparent pr-1 transition-colors",
                        selectedFolderId === folder.id &&
                            "border-primary/20 bg-primary/10",
                        dropTarget?.folderId === folder.id &&
                            dropTarget.placement === "inside" &&
                            "border-primary bg-primary/10",
                        dropTarget?.folderId === folder.id &&
                            dropTarget.placement === "before" &&
                            "border-t-primary",
                        dropTarget?.folderId === folder.id &&
                            dropTarget.placement === "after" &&
                            "border-b-primary",
                        recordingDropFolderId === folder.id &&
                            "border-primary bg-primary/10 ring-1 ring-primary/30",
                    )}
                    style={{ paddingLeft: `${depth * 12 + 2}px` }}
                    onContextMenu={(event) => {
                        event.preventDefault();
                        setMenuFolderId(folder.id);
                    }}
                >
                    {canExpand ? (
                        <button
                            type="button"
                            className="flex size-7 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
                            aria-expanded={isExpanded}
                            aria-label={
                                isExpanded
                                    ? i18n("Collapse folder")
                                    : i18n("Expand folder")
                            }
                            onClick={() => {
                                const next = new Set(expanded);
                                if (isExpanded) next.delete(folder.id);
                                else next.add(folder.id);
                                setExpanded(next);
                                setPreferences((value) => ({
                                    ...value,
                                    expanded: [...next],
                                }));
                            }}
                        >
                            {isExpanded ? (
                                <ChevronDown className="size-4" />
                            ) : (
                                <ChevronRight className="size-4" />
                            )}
                        </button>
                    ) : (
                        <span className="size-7 shrink-0" aria-hidden="true" />
                    )}
                    <button
                        type="button"
                        draggable={
                            folder.kind === "custom" &&
                            canManage &&
                            !folder.receivedFolder
                        }
                        title={
                            folder.receivedFolder
                                ? `${i18n("Shared by {owner}", {
                                      owner: folder.receivedFolder.ownerName,
                                  })} (${folder.receivedFolder.originalName})`
                                : undefined
                        }
                        onDragStart={(event) => {
                            setDraggedFolderId(folder.id);
                            event.dataTransfer.setData(
                                FOLDER_DRAG_TYPE,
                                folder.id,
                            );
                            event.dataTransfer.effectAllowed = "move";
                        }}
                        onDragEnd={() => {
                            setDraggedFolderId(null);
                            setDropTarget(null);
                        }}
                        onDragOver={(event) => {
                            const isRecordingDrag = Array.from(
                                event.dataTransfer.types ?? [],
                            ).includes(RECORDING_DRAG_TYPE);
                            if (isRecordingDrag) {
                                if (folder.kind === "private") {
                                    event.dataTransfer.dropEffect = "none";
                                    setRecordingDropFolderId(null);
                                    return;
                                }
                                const effect = recordingDropEffect(
                                    Array.from(event.dataTransfer.types),
                                    folder.scope,
                                    !!onMoveRecording,
                                );
                                event.dataTransfer.dropEffect = effect;
                                if (effect === "none") {
                                    setRecordingDropFolderId(null);
                                    return;
                                }
                                event.preventDefault();
                                setDropTarget(null);
                                setRecordingDropFolderId(folder.id);
                                return;
                            }
                            if (
                                !draggedFolderId ||
                                !canDropFolderOn(draggedFolderId, folder)
                            ) {
                                setDropTarget(null);
                                return;
                            }
                            event.preventDefault();
                            event.dataTransfer.dropEffect = "move";
                            setRecordingDropFolderId(null);
                            setDropTarget({
                                folderId: folder.id,
                                placement: dropPlacementFor(event, folder),
                            });
                        }}
                        onDragLeave={() => {
                            setDropTarget(null);
                            setRecordingDropFolderId(null);
                        }}
                        onDrop={(event) => {
                            const recordingId = Array.from(
                                event.dataTransfer.types ?? [],
                            ).includes(RECORDING_DRAG_TYPE)
                                ? event.dataTransfer.getData(
                                      RECORDING_DRAG_TYPE,
                                  )
                                : "";
                            if (recordingId) {
                                const recording =
                                    recordings.find(
                                        (item) =>
                                            item.id === recordingId &&
                                            item.view === "org",
                                    ) ??
                                    recordings.find(
                                        (item) => item.id === recordingId,
                                    );
                                if (
                                    folder.kind === "private" ||
                                    recordingDropEffect(
                                        Array.from(event.dataTransfer.types),
                                        folder.scope,
                                        !!onMoveRecording,
                                    ) === "none" ||
                                    (recording?.isOwn === false &&
                                        folder.scope !== "org")
                                ) {
                                    event.dataTransfer.dropEffect = "none";
                                    setRecordingDropFolderId(null);
                                    return;
                                }
                                event.preventDefault();
                                setDropTarget(null);
                                setRecordingDropFolderId(null);
                                const sourceFolderId =
                                    event.dataTransfer.getData(
                                        RECORDING_SOURCE_FOLDER_DRAG_TYPE,
                                    );
                                if (
                                    sourceFolderId &&
                                    byId.get(sourceFolderId)?.scope ===
                                        folder.scope &&
                                    onMoveRecording
                                ) {
                                    if (sourceFolderId !== folder.id) {
                                        void onMoveRecording(
                                            recordingId,
                                            sourceFolderId,
                                            folder.id,
                                        ).catch(() => {});
                                    }
                                } else {
                                    void onAssignRecording(
                                        recordingId,
                                        folder.id,
                                    ).catch(() => {});
                                }
                                return;
                            }
                            const draggedId =
                                draggedFolderId ||
                                event.dataTransfer.getData(FOLDER_DRAG_TYPE);
                            if (!canDropFolderOn(draggedId, folder)) {
                                setDropTarget(null);
                                setDraggedFolderId(null);
                                return;
                            }
                            event.preventDefault();
                            const placement =
                                dropTarget?.folderId === folder.id
                                    ? dropTarget.placement
                                    : dropPlacementFor(event, folder);
                            setDropTarget(null);
                            setDraggedFolderId(null);
                            if (draggedId) {
                                dropFolder(draggedId, folder, placement);
                            }
                        }}
                        onClick={() => onSelectFolder(folder)}
                        onKeyDown={(event) => {
                            if (
                                event.key === "ContextMenu" ||
                                (event.shiftKey && event.key === "F10")
                            ) {
                                event.preventDefault();
                                setMenuFolderId(folder.id);
                            }
                        }}
                        aria-label={i18n(
                            "{folder}, {count, plural, one {# recording} other {# recordings}}",
                            {
                                folder: folderLabel(folder),
                                count: countByFolder.get(folder.id) ?? 0,
                            },
                        )}
                        aria-current={
                            selectedFolderId === folder.id
                                ? "location"
                                : undefined
                        }
                        className="flex min-w-0 flex-1 items-center gap-1.5 py-1.5 text-left text-[13px]"
                    >
                        {folder.kind === "public" ? (
                            <Users className="size-4 shrink-0 text-organization" />
                        ) : (
                            <SharedFolderIcon
                                folder={folder}
                                className={
                                    folder.kind !== "custom"
                                        ? "fill-primary/10"
                                        : undefined
                                }
                            />
                        )}
                        <span className="truncate">{folderLabel(folder)}</span>
                        <span className="ml-auto text-xs tabular-nums text-muted-foreground">
                            {countByFolder.get(folder.id) ?? 0}
                        </span>
                    </button>
                    <DropdownMenu
                        open={menuFolderId === folder.id}
                        onOpenChange={(open) =>
                            setMenuFolderId(open ? folder.id : null)
                        }
                    >
                        <DropdownMenuTrigger asChild>
                            <Button
                                type="button"
                                variant="ghost"
                                size="icon-sm"
                                className="size-7 opacity-100 sm:opacity-0 sm:group-hover/folder:opacity-100 data-[state=open]:opacity-100"
                                aria-label={i18n(
                                    "Folder actions for {folder}",
                                    { folder: folderLabel(folder) },
                                )}
                            >
                                <MoreHorizontal className="size-4" />
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                            {folder.receivedFolder ? (
                                <ReceivedFolderMenu
                                    folder={folder}
                                    onEdit={(action) =>
                                        setAttachmentEdit({ folder, action })
                                    }
                                />
                            ) : (
                                <>
                                    {canCreateSubfolder(
                                        folder,
                                        canCurate,
                                        isOrgAccount,
                                    ) && (
                                        <DropdownMenuItem
                                            onSelect={() =>
                                                onSettings(folder, "create")
                                            }
                                        >
                                            <FolderPlus />{" "}
                                            {i18n("New subfolder")}
                                        </DropdownMenuItem>
                                    )}
                                    {onPrepareMeeting &&
                                        folder.kind !== "private" &&
                                        !folder.receivedFolder && (
                                            <DropdownMenuItem
                                                onSelect={() =>
                                                    onPrepareMeeting(folder)
                                                }
                                            >
                                                <CalendarClock />
                                                {i18n("Prepare an agenda")}
                                            </DropdownMenuItem>
                                        )}
                                    {sharingEnabled &&
                                        folder.scope === "personal" &&
                                        folder.kind === "custom" && (
                                            <DropdownMenuItem
                                                onSelect={() =>
                                                    setSharingFolder(folder)
                                                }
                                            >
                                                <UserPlus />
                                                {i18n("Share folder…")}
                                            </DropdownMenuItem>
                                        )}
                                    <DropdownMenuItem
                                        onSelect={() => onSettings(folder)}
                                    >
                                        <Settings /> {i18n("Folder settings")}
                                    </DropdownMenuItem>
                                </>
                            )}
                        </DropdownMenuContent>
                    </DropdownMenu>
                </div>
                {isExpanded && renderLevel(children, depth + 1, folder.id)}
            </div>
        );
    };

    const renderLevel = (
        level: RecordingFolder[],
        depth: number,
        parentId: string,
    ) => {
        const visible = visibleFolderLevel(
            level,
            activity,
            currentPath,
            8,
            !!query.trim() || allLevels.has(parentId),
        );
        return (
            <>
                {visible.map((folder) => renderFolder(folder, depth))}
                {visible.length < level.length && (
                    <Button
                        variant="ghost"
                        size="sm"
                        className="text-xs text-muted-foreground"
                        onClick={() =>
                            setAllLevels((current) =>
                                new Set(current).add(parentId),
                            )
                        }
                    >
                        {i18n(
                            "{count, plural, one {All # folder} other {All # folders}}",
                            { count: level.length },
                        )}
                    </Button>
                )}
            </>
        );
    };

    return (
        <>
            {sharingFolder && (
                <PersonShareDialog
                    itemId={sharingFolder.id}
                    title={sharingFolder.name}
                    kind="folder"
                    open
                    onOpenChange={(open) => {
                        if (!open) setSharingFolder(null);
                    }}
                />
            )}
            {attachmentEdit?.folder.receivedFolder && (
                <ReceivedFolderDialog
                    key={`${attachmentEdit.folder.id}:${attachmentEdit.action}`}
                    shareId={attachmentEdit.folder.receivedFolder.shareId}
                    version={attachmentEdit.folder.receivedFolder.shareVersion}
                    name={attachmentEdit.folder.name}
                    ownerName={attachmentEdit.folder.receivedFolder.ownerName}
                    parentId={attachmentEdit.folder.parentId}
                    action={attachmentEdit.action}
                    folders={folders}
                    open
                    onOpenChange={(open) => {
                        if (!open) setAttachmentEdit(null);
                    }}
                />
            )}
            <Card
                hasNoPadding
                className="flex h-full min-h-0 flex-col overflow-hidden"
            >
                <CardContent className="flex min-h-0 flex-1 flex-col p-0">
                    <div className="flex items-center gap-1 border-b p-2">
                        <div className="relative min-w-0 flex-1">
                            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                            <Input
                                value={query}
                                onChange={(event) =>
                                    setQuery(event.target.value)
                                }
                                placeholder={i18n("Find a folder")}
                                aria-label={i18n("Search folders")}
                                className="h-8 pl-8 pr-8 text-xs"
                            />
                            {!query && (
                                <kbd className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground">
                                    {isMac ? "⌘K" : "Ctrl K"}
                                </kbd>
                            )}
                            {query && (
                                <button
                                    type="button"
                                    onClick={() => setQuery("")}
                                    aria-label={i18n("Clear search")}
                                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
                                >
                                    <X className="size-4" />
                                </button>
                            )}
                        </div>
                        {onCollapse && (
                            <Tooltip>
                                <TooltipTrigger asChild>
                                    <Button
                                        variant="ghost"
                                        size="icon-sm"
                                        aria-label={i18n("Hide folders")}
                                        onClick={onCollapse}
                                    >
                                        <PanelLeftClose className="size-4" />
                                    </Button>
                                </TooltipTrigger>
                                <TooltipContent>
                                    {i18n("Hide folders")}
                                </TooltipContent>
                            </Tooltip>
                        )}
                    </div>
                    <div className="min-h-0 flex-1 overflow-y-auto p-1">
                        <Button
                            variant="ghost"
                            className="w-full justify-start gap-2 text-sm"
                            aria-current={
                                !selectedFolderId ? "location" : undefined
                            }
                            onClick={onRecent}
                        >
                            <History className="size-4" />
                            {i18n("Recent")}
                            <span className="ml-auto text-xs tabular-nums text-muted-foreground">
                                {recentCount ??
                                    recordings.filter(
                                        (item) => item.view !== "org",
                                    ).length}
                            </span>
                        </Button>
                        {!query.trim() && recentFolders.length > 0 && (
                            <div className="border-b pb-2">
                                <p className="px-2 py-2 text-xs text-muted-foreground">
                                    {i18n("Recently used")}
                                </p>
                                {recentFolders.map((folder) => (
                                    <button
                                        key={folder.id}
                                        type="button"
                                        onClick={() => onSelectFolder(folder)}
                                        className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] hover:bg-accent"
                                    >
                                        {folder.scope === "org" ? (
                                            <Users className="size-4 text-organization" />
                                        ) : (
                                            <SharedFolderIcon folder={folder} />
                                        )}
                                        <span className="truncate">
                                            {folderLabel(folder)}
                                        </span>
                                        <span className="ml-auto text-xs text-muted-foreground">
                                            {countByFolder.get(folder.id) ?? 0}
                                        </span>
                                    </button>
                                ))}
                            </div>
                        )}
                        {renderLevel(
                            childrenByParent.get(null) ?? [],
                            0,
                            "roots",
                        )}
                        {onNewFolder && (
                            <Button
                                variant="ghost"
                                size="sm"
                                className="mt-2 w-full justify-start"
                                onClick={onNewFolder}
                            >
                                <FolderPlus className="size-4" />
                                {i18n("New folder")}
                            </Button>
                        )}
                        {matchingIds?.size === 0 && (
                            <p className="px-3 py-8 text-center text-sm text-muted-foreground">
                                {i18n("No folders match your search.")}
                            </p>
                        )}
                    </div>
                </CardContent>
            </Card>
        </>
    );
}
