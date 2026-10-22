"use client";

import {
    ArrowLeft,
    Folder,
    FolderPlus,
    PanelLeftOpen,
    Users,
} from "lucide-react";
import { useExtracted } from "next-intl";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
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
    onNewFolder,
    onAssign,
    onMove,
    onShowRail,
    navigation,
    part = "all",
    canCurate = false,
    isOrgAccount = false,
}: {
    variant: "rail" | "walk";
    organization: FolderOrganization;
    recordings: Recording[];
    folder: RecordingFolder | null;
    onNavigate: (folder: RecordingFolder | null) => void;
    onSettings: (folder: RecordingFolder) => void;
    onNewFolder: () => void;
    onAssign: (recordingId: string, folderId: string) => Promise<void>;
    onMove: (recordingId: string, from: string, to: string) => Promise<void>;
    onShowRail?: () => void;
    navigation?: FolderNavigation;
    part?: "all" | "header" | "tiles";
    canCurate?: boolean;
    isOrgAccount?: boolean;
}) {
    const i18n = useExtracted();
    const label = useFolderLabel();
    const { recentFolders } = useLibraryPreferences();
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
                    if (item.kind === "private") {
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
                if (item.kind === "private") return;
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
                    <Folder
                        className={
                            item.scope === "org"
                                ? "size-4 shrink-0 text-organization"
                                : "size-4 shrink-0 text-primary"
                        }
                    />
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
                        <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={i18n("Back to parent folder")}
                            onClick={() =>
                                onNavigate(
                                    byId.get(folder.parentId ?? "") ?? null,
                                )
                            }
                        >
                            <ArrowLeft className="size-4" />
                        </Button>
                    )}
                    <nav
                        aria-label={i18n("Folder path")}
                        className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden whitespace-nowrap text-xs text-muted-foreground"
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
                                            onClick={() => onNavigate(null)}
                                        >
                                            {i18n("Chatter")}
                                        </button>
                                        <span aria-hidden="true">›</span>
                                    </>
                                )}
                                {path.map((item, index) => (
                                    <span
                                        key={item.id}
                                        className="inline-flex min-w-0 items-center gap-1 last:shrink-0"
                                    >
                                        {index > 0 && (
                                            <span aria-hidden="true">›</span>
                                        )}
                                        <button
                                            type="button"
                                            aria-label={
                                                item.id === folder.id
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
                                                item.id === folder.id
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
                    {variant === "walk" && onShowRail && (
                        <Button
                            variant="ghost"
                            size="icon-sm"
                            className="hidden xl:inline-flex"
                            aria-label={i18n("Show folders")}
                            onClick={onShowRail}
                        >
                            <PanelLeftOpen className="size-4" />
                        </Button>
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
                                    <Folder
                                        className={
                                            item.scope === "org"
                                                ? "size-3 text-organization"
                                                : "size-3 text-primary"
                                        }
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
                            canCreateSubfolder(folder, canCurate, isOrgAccount)
                                ? i18n("New subfolder")
                                : i18n("New folder")}
                        </Button>
                    </div>
                </>
            )}
        </section>
    );
}
