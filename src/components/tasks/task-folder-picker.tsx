"use client";

import { useExtracted } from "next-intl";
import { FolderCombobox } from "@/components/recordings/folder-combobox";
import { useFolderLabel } from "@/hooks/use-folder-label";
import { folderDisplayPath } from "@/lib/folders/labels";
import { matchFolders } from "@/lib/folders/navigation";
import { privateTreeFolders } from "@/lib/folders/private-tree";
import type { TaskFolder } from "@/lib/tasks/folders";
import type { RecordingFolder } from "@/types/folder";

/** Own-task filing uses the shared folder search, limited to the Private tree. */
export function TaskFolderPicker({
    folders,
    value,
    onChange,
    row = false,
    disabled = false,
    fallbackName,
}: {
    folders: RecordingFolder[];
    value: string | null;
    onChange: (folder: TaskFolder | null) => void;
    row?: boolean;
    disabled?: boolean;
    fallbackName?: string;
}) {
    const i18n = useExtracted();
    const label = useFolderLabel();
    const privateFolders = privateTreeFolders(folders);
    const byId = new Map(privateFolders.map((folder) => [folder.id, folder]));
    const emptyLabel = row ? i18n("File in a folder") : i18n("No folder");
    return (
        <FolderCombobox
            entries={matchFolders(
                privateFolders.filter((folder) => folder.kind !== "private"),
                "",
                label,
            )}
            value={value ?? ""}
            variant="pill"
            disabled={disabled}
            aria-label={i18n("Task folder")}
            placeholder={value && fallbackName ? fallbackName : emptyLabel}
            emptyChoiceLabel={i18n("No folder")}
            className={
                row
                    ? `border-0 px-0 py-0 ${value ? "" : "task-row-folder-action"}`
                    : undefined
            }
            onValueChange={(id) => {
                const folder = byId.get(id);
                onChange(
                    folder
                        ? {
                              id,
                              name: folder.name,
                              path: folderDisplayPath(
                                  folder,
                                  byId,
                                  (entry) => entry.name,
                              ),
                          }
                        : null,
                );
            }}
        />
    );
}
