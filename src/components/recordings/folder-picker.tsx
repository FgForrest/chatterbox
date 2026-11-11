"use client";

import { useExtracted } from "next-intl";
import { type ReactNode, type RefObject, useId, useMemo } from "react";
import { NewFolderForm } from "@/components/pipeline/new-folder-form";
import { FolderCombobox } from "@/components/recordings/folder-combobox";
import { useFolderLabel } from "@/hooks/use-folder-label";
import { useLibraryPreferences } from "@/hooks/use-library-preferences";
import { joinFolderPath, matchFolders } from "@/lib/folders/navigation";
import { canCreateSubfolder } from "@/lib/folders/permissions";
import type { RecordingFolder } from "@/types/folder";

/** Filing rules shared by folder action chips and row menus. */
export function FolderPicker({
    folders,
    assignedIds,
    open,
    onOpenChange,
    onSelect,
    organizationOnly = false,
    sharing = false,
    scope,
    canCurate = false,
    onCreated,
    title,
    allowCreate = true,
    actionTrigger,
    anchorRef,
    "aria-label": ariaLabel,
}: {
    folders: RecordingFolder[];
    assignedIds: ReadonlySet<string>;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onSelect: (folderId: string) => Promise<void>;
    organizationOnly?: boolean;
    sharing?: boolean;
    scope?: RecordingFolder["scope"];
    canCurate?: boolean;
    onCreated?: (folder: RecordingFolder) => void;
    title?: string;
    "aria-label"?: string;
    allowCreate?: boolean;
    actionTrigger?: ReactNode;
    anchorRef?: RefObject<HTMLButtonElement | null>;
}) {
    const i18n = useExtracted();
    const label = useFolderLabel();
    const id = useId();
    const { rememberFolder } = useLibraryPreferences();
    const entries = useMemo(
        () =>
            matchFolders(
                folders.filter(
                    (folder) =>
                        (!scope || !folder.receivedFolder) &&
                        (!organizationOnly || folder.scope === "org") &&
                        (!scope || folder.scope === scope),
                ),
                "",
                label,
            ),
        [folders, organizationOnly, scope, label],
    );
    const parents = entries.filter(({ folder }) =>
        canCreateSubfolder(folder, canCurate),
    );
    return (
        <FolderCombobox
            entries={entries.filter(({ folder }) => folder.kind !== "private")}
            value=""
            assignedIds={assignedIds}
            sharing={sharing}
            open={open}
            onOpenChange={onOpenChange}
            anchorRef={anchorRef}
            actionTrigger={actionTrigger}
            variant="pill"
            className="h-7 rounded-full border-dashed px-2.5 text-xs text-muted-foreground"
            aria-label={ariaLabel ?? title ?? i18n("Choose a folder")}
            popupTitle={title}
            onValueChange={onSelect}
            createOnlyWhenEmpty
            createForm={
                allowCreate && parents.length > 0
                    ? (query, back, close) => (
                          <NewFolderForm
                              initialName={query}
                              parents={parents.map(({ folder, path }) => ({
                                  id: folder.id,
                                  path: joinFolderPath(path, label(folder)),
                                  folder,
                              }))}
                              idPrefix={id}
                              onCancel={back}
                              onCreated={async (folder) => {
                                  onCreated?.(folder);
                                  try {
                                      await onSelect(folder.id);
                                      rememberFolder(folder.id);
                                      close();
                                  } catch {
                                  } finally {
                                      back();
                                  }
                              }}
                          />
                      )
                    : undefined
            }
        />
    );
}
