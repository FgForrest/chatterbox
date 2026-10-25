"use client";

import {
    ArrowLeft,
    BookOpen,
    FolderPlus,
    MoreHorizontal,
    PanelLeftOpen,
    Users,
} from "lucide-react";
import { useExtracted } from "next-intl";
import { useMemo, useState } from "react";
import {
    ReceivedFolderDialog,
    ReceivedFolderMenu,
} from "@/components/sharing/folder-sharing";
import { SharedFolderIcon } from "@/components/sharing/shared-folder-icon";
import { Button } from "@/components/ui/button";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ActionTooltip, TooltipProvider } from "@/components/ui/tooltip";
import { useFolderLabel } from "@/hooks/use-folder-label";
import { useLibraryPreferences } from "@/hooks/use-library-preferences";
import {
    RECORDING_DRAG_TYPE,
    RECORDING_SOURCE_FOLDER_DRAG_TYPE,
    recordingDropEffect,
} from "@/lib/folders/drag";
import {
    ancestorFolderIds,
    descendantFolderIds,
} from "@/lib/folders/hierarchy";
import {
    type FolderNavigation,
    libraryNavigation,
    visibleFolderLevel,
} from "@/lib/folders/navigation";
import { canCreateSubfolder } from "@/lib/folders/permissions";
import type { FolderOrganization, RecordingFolder } from "@/types/folder";
import type { Recording } from "@/types/recording";

export function LibraryLocationHeader({
    variant,
    organization,
    recordings,
    folder,
    onNavigate,
    onSettings,
    onKnowledge,
    knowledgeOpen = false,
    onNewFolder,
    onAssign,
    onMove,
    onShowRail,
    navigation,
    part = "all",
    canCurate = false,
    isOrgAccount = false,
    shownCount,
}: {
    variant: "rail" | "walk";
    organization: FolderOrganization;
    recordings: Recording[];
    folder: RecordingFolder | null;
    onNavigate: (folder: RecordingFolder | null) => void;
    onSettings: (folder: RecordingFolder) => void;
    onKnowledge?: (folder: RecordingFolder) => void;
    knowledgeOpen?: boolean;
    onNewFolder: () => void;
    onAssign: (recordingId: string, folderId: string) => Promise<void>;
    onMove: (recordingId: string, from: string, to: string) => Promise<void>;
    onShowRail?: () => void;
    navigation?: FolderNavigation;
    part?: "all" | "header" | "tiles";
    canCurate?: boolean;
    isOrgAccount?: boolean;
    /** How many items the list below shows; nothing is shown for none. */
    shownCount?: number;
}) {
    const i18n = useExtracted();
    const label = useFolderLabel();
    const { recentFolders } = useLibraryPreferences();
    const [attachmentEdit, setAttachmentEdit] = useState<
        "rename" | "move" | null
    >(null);
    const [allLocation, setAllLocation] = useState<string | null>(null);
    const { folders, assignments } = organization;
    const data = useMemo(
        () =>
            navigation ??
            libraryNavigation(folders, assignments, recordings, label),
        [navigation, folders, assignments, recordings, label],
    );
    if (part === "tiles" && variant === "rail") return null;
    const pathIds = folder
        ? ancestorFolderIds(folders, folder.id)
        : new Set<string>();
    const byId = new Map(folders.map((item) => [item.id, item]));
    const path = [...pathIds].reverse().flatMap((id) => byId.get(id) ?? []);
    const crumbs = variant === "rail" && folder ? [folder] : path;
    const countLabel =
        shownCount === undefined
            ? null
            : folder
              ? i18n(
                    "{count, plural, one {# item, including subfolders} other {# items, including subfolders}}",
                    { count: shownCount },
                )
              : i18n("{count, plural, one {# item} other {# items}}", {
                    count: shownCount,
                });
    const level = folders.filter(
        (item) => item.parentId === (folder?.id ?? null),
    );
    const visible = visibleFolderLevel(
        level,
        data.activity,
        pathIds,
        6,
        allLocation === (folder?.id ?? "recent"),
    );
    const tile = (item: RecordingFolder) => (
        <button
            key={item.id}
            type="button"
            onClick={() => onNavigate(item)}
            onDragOver={(event) => {
                const types = Array.from(event.dataTransfer.types);
                if (types.includes(RECORDING_DRAG_TYPE)) {
                    if (item.kind === "private" || item.receivedFolder) {
                        event.dataTransfer.dropEffect = "none";
                        return;
                    }
                    const effect = recordingDropEffect(types, item.scope, true);
                    event.dataTransfer.dropEffect = effect;
                    if (effect === "none") return;
                    event.preventDefault();
                }
            }}
            onDrop={(event) => {
                if (item.kind === "private" || item.receivedFolder) return;
                const id = event.dataTransfer.getData(RECORDING_DRAG_TYPE);
                if (!id) return;
                const recording =
                    recordings.find(
                        (entry) => entry.id === id && entry.view === "org",
                    ) ?? recordings.find((entry) => entry.id === id);
                if (
                    recordingDropEffect(
                        Array.from(event.dataTransfer.types),
                        item.scope,
                        true,
                    ) === "none" ||
                    (recording?.isOwn === false && item.scope !== "org")
                ) {
                    event.dataTransfer.dropEffect = "none";
                    return;
                }
                event.preventDefault();
                const source = event.dataTransfer.getData(
                    RECORDING_SOURCE_FOLDER_DRAG_TYPE,
                );
                if (source === item.id) return;
                const sameScope = byId.get(source)?.scope === item.scope;
                void (
                    source && sameScope
                        ? onMove(id, source, item.id)
                        : onAssign(id, item.id)
                ).catch(() => {});
            }}
            className="min-w-0 rounded-lg border p-2 text-left hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
        >
            <span className="flex min-w-0 items-center gap-1.5 text-[13px] font-medium">
                {item.kind === "public" ? (
                    <Users className="size-4 shrink-0 text-organization" />
                ) : (
                    <SharedFolderIcon folder={item} />
                )}
                <span className="truncate">{label(item)}</span>
                {folder && (
                    <span className="ml-auto text-xs text-muted-foreground">
                        {data.counts.get(item.id) ?? 0}
                    </span>
                )}
            </span>
            {!folder && (
                <span className="mt-1 block text-[11px] text-muted-foreground">
                    {i18n(
                        "{items, plural, one {# item} other {# items}}, {folders, plural, one {# folder} other {# folders}}",
                        {
                            items: data.counts.get(item.id) ?? 0,
                            folders:
                                descendantFolderIds(folders, item.id).size - 1,
                        },
                    )}
                </span>
            )}
        </button>
    );
    return (
        <TooltipProvider delayDuration={200}>
            <section
                className="space-y-2 border-b p-3"
                aria-label={
                    variant === "walk"
                        ? i18n("Folder navigation")
                        : i18n("Current location")
                }
            >
                {part !== "tiles" && (
                    <div className="flex items-center gap-1">
                        {variant === "walk" && folder && (
                            <ActionTooltip
                                label={i18n("Back to parent folder")}
                            >
                                <Button
                                    variant="ghost"
                                    size="icon-sm"
                                    aria-label={i18n("Back to parent folder")}
                                    onClick={() =>
                                        onNavigate(
                                            byId.get(folder.parentId ?? "") ??
                                                null,
                                        )
                                    }
                                >
                                    <ArrowLeft className="size-4" />
                                </Button>
                            </ActionTooltip>
                        )}
                        <div className="flex min-w-0 flex-1 items-center gap-2">
                            <nav
                                aria-label={i18n("Folder path")}
                                title={
                                    variant === "rail" && folder
                                        ? path
                                              .map((item) => label(item))
                                              .join(" › ")
                                        : undefined
                                }
                                className="flex min-w-0 items-center gap-1 overflow-hidden whitespace-nowrap text-xs text-muted-foreground"
                            >
                                {!folder ? (
                                    <span className="font-semibold text-foreground">
                                        {i18n("Recent")}
                                    </span>
                                ) : (
                                    <>
                                        {variant === "walk" && (
                                            <>
                                                <button
                                                    type="button"
                                                    className="hover:text-foreground"
                                                    onClick={() =>
                                                        onNavigate(null)
                                                    }
                                                >
                                                    {i18n("Chatter")}
                                                </button>
                                                <span aria-hidden="true">
                                                    ›
                                                </span>
                                            </>
                                        )}
                                        {crumbs.map((item, index) => (
                                            <span
                                                key={item.id}
                                                className="inline-flex min-w-0 items-center gap-1 last:shrink-0"
                                            >
                                                {index > 0 && (
                                                    <span aria-hidden="true">
                                                        ›
                                                    </span>
                                                )}
                                                <button
                                                    type="button"
                                                    aria-label={
                                                        item.id === folder.id &&
                                                        !folder.receivedFolder
                                                            ? i18n(
                                                                  "Folder settings for {folder}",
                                                                  {
                                                                      folder: label(
                                                                          item,
                                                                      ),
                                                                  },
                                                              )
                                                            : undefined
                                                    }
                                                    aria-current={
                                                        item.id === folder.id
                                                            ? "location"
                                                            : undefined
                                                    }
                                                    className="max-w-44 truncate hover:text-foreground aria-[current=location]:font-semibold aria-[current=location]:text-foreground"
                                                    onClick={() =>
                                                        item.id === folder.id &&
                                                        !folder.receivedFolder
                                                            ? onSettings(folder)
                                                            : onNavigate(item)
                                                    }
                                                >
                                                    {label(item)}
                                                </button>
                                            </span>
                                        ))}
                                    </>
                                )}
                            </nav>
                            {countLabel && shownCount !== 0 && (
                                <span
                                    className="shrink-0 text-xs tabular-nums text-muted-foreground"
                                    title={countLabel}
                                >
                                    <span aria-hidden="true">{shownCount}</span>
                                    <span className="sr-only">
                                        {countLabel}
                                    </span>
                                </span>
                            )}
                        </div>
                        {folder?.receivedFolder && (
                            <>
                                <DropdownMenu>
                                    <ActionTooltip
                                        label={i18n(
                                            "Folder actions for {folder}",
                                            {
                                                folder: folder.name,
                                            },
                                        )}
                                    >
                                        <DropdownMenuTrigger asChild>
                                            <Button
                                                variant="ghost"
                                                size="icon-sm"
                                                aria-label={i18n(
                                                    "Folder actions for {folder}",
                                                    { folder: folder.name },
                                                )}
                                            >
                                                <MoreHorizontal className="size-4" />
                                            </Button>
                                        </DropdownMenuTrigger>
                                    </ActionTooltip>
                                    <DropdownMenuContent>
                                        <ReceivedFolderMenu
                                            folder={folder}
                                            onEdit={setAttachmentEdit}
                                        />
                                    </DropdownMenuContent>
                                </DropdownMenu>
                                {attachmentEdit && (
                                    <ReceivedFolderDialog
                                        key={`${folder.id}:${attachmentEdit}`}
                                        shareId={folder.receivedFolder.shareId}
                                        version={
                                            folder.receivedFolder.shareVersion
                                        }
                                        name={folder.name}
                                        ownerName={
                                            folder.receivedFolder.ownerName
                                        }
                                        parentId={folder.parentId}
                                        action={attachmentEdit}
                                        folders={folders}
                                        open
                                        onOpenChange={(open) => {
                                            if (!open) setAttachmentEdit(null);
                                        }}
                                    />
                                )}
                            </>
                        )}
                        {folder && !folder.receivedFolder && onKnowledge && (
                            <ActionTooltip label={i18n("Knowledge")}>
                                <Button
                                    variant="outline"
                                    size="icon-sm"
                                    aria-pressed={knowledgeOpen}
                                    aria-label={i18n("Knowledge")}
                                    className={
                                        folder.scope === "org"
                                            ? "shrink-0 border-organization/40 bg-organization/10 text-organization hover:bg-organization/20 hover:text-organization"
                                            : "shrink-0"
                                    }
                                    onClick={() => onKnowledge(folder)}
                                >
                                    <BookOpen className="size-4" />
                                </Button>
                            </ActionTooltip>
                        )}
                        {folder && !folder.receivedFolder && (
                            <ActionTooltip label={i18n("Folder settings")}>
                                <Button
                                    variant="ghost"
                                    size="icon-sm"
                                    className="shrink-0"
                                    aria-label={i18n("Folder settings")}
                                    onClick={() => onSettings(folder)}
                                >
                                    <MoreHorizontal className="size-4" />
                                </Button>
                            </ActionTooltip>
                        )}
                        {variant === "walk" && onShowRail && (
                            <ActionTooltip label={i18n("Show folders")}>
                                <Button
                                    variant="ghost"
                                    size="icon-sm"
                                    className="hidden xl:inline-flex"
                                    aria-label={i18n("Show folders")}
                                    onClick={onShowRail}
                                >
                                    <PanelLeftOpen className="size-4" />
                                </Button>
                            </ActionTooltip>
                        )}
                    </div>
                )}
                {part !== "header" && variant === "walk" && (
                    <>
                        <div className="grid grid-cols-2 gap-1.5">
                            {visible.map(tile)}
                            {visible.length < level.length && (
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    className="text-xs"
                                    onClick={() =>
                                        setAllLocation(folder?.id ?? "recent")
                                    }
                                >
                                    {i18n(
                                        "{count, plural, one {All # folder} other {All # folders}}",
                                        {
                                            count: level.length,
                                        },
                                    )}
                                </Button>
                            )}
                        </div>
                        {!folder && recentFolders.length > 0 && (
                            // biome-ignore lint/a11y/useSemanticElements: These shortcuts navigate folders, rather than grouping form inputs.
                            <div
                                role="group"
                                className="flex flex-wrap gap-1.5"
                                aria-label={i18n("Recently used")}
                            >
                                {recentFolders.map((item) => (
                                    <Button
                                        key={item.id}
                                        variant="outline"
                                        size="sm"
                                        className="h-6 max-w-full rounded-full px-2 text-xs"
                                        onClick={() => onNavigate(item)}
                                    >
                                        <SharedFolderIcon
                                            folder={item}
                                            className="size-3"
                                        />
                                        <span className="truncate">
                                            {label(item)}
                                        </span>
                                        <span className="text-muted-foreground">
                                            {data.counts.get(item.id) ?? 0}
                                        </span>
                                    </Button>
                                ))}
                            </div>
                        )}
                        <div className="flex justify-end">
                            <Button
                                variant="ghost"
                                size="sm"
                                className="h-6 px-1 text-xs"
                                onClick={onNewFolder}
                            >
                                <FolderPlus className="size-3" />
                                {folder &&
                                canCreateSubfolder(
                                    folder,
                                    canCurate,
                                    isOrgAccount,
                                )
                                    ? i18n("New subfolder")
                                    : i18n("New folder")}
                            </Button>
                        </div>
                    </>
                )}
            </section>
        </TooltipProvider>
    );
}
