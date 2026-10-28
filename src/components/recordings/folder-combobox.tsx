"use client";

import { Folder, Users } from "lucide-react";
import { useExtracted } from "next-intl";
import {
    type FolderSearchEntry,
    FolderSearchList,
} from "@/components/recordings/folder-search-list";
import { SharedFolderIcon } from "@/components/sharing/shared-folder-icon";
import { Combobox } from "@/components/ui/search-combobox";
import { useFolderLabel } from "@/hooks/use-folder-label";
import { useLibraryPreferences } from "@/hooks/use-library-preferences";
import { joinFolderPath } from "@/lib/folders/navigation";

interface FolderComboboxProps {
    entries: FolderSearchEntry[];
    value: string;
    onValueChange: (folderId: string) => void;
    onCreate?: (query: string) => void;
    disabled?: boolean;
    "aria-label"?: string;
    variant?: "field" | "pill";
    placeholder?: string;
    emptyChoiceLabel?: string;
    className?: string;
}

/** Inline folder choice with the same search and recent folders as FolderPicker. */
export function FolderCombobox({
    entries,
    value,
    onValueChange,
    onCreate,
    disabled = false,
    "aria-label": ariaLabel,
    variant = "field",
    placeholder,
    emptyChoiceLabel,
    className = "",
}: FolderComboboxProps) {
    const i18n = useExtracted();
    const label = useFolderLabel();
    const { rememberFolder } = useLibraryPreferences();
    const selected = entries.find((entry) => entry.folder.id === value);
    const selectedPath = selected
        ? joinFolderPath(selected.path, label(selected.folder))
        : undefined;
    return (
        <Combobox
            aria-label={ariaLabel ?? i18n("Folder")}
            title={selectedPath}
            disabled={disabled}
            variant={variant}
            className={className}
            valueLabel={
                <>
                    {selected?.folder.receivedFolder ? (
                        <SharedFolderIcon folder={selected.folder} />
                    ) : (
                        variant === "pill" && (
                            <Folder className="size-3 shrink-0" aria-hidden />
                        )
                    )}
                    {selected?.folder.scope === "org" && (
                        <Users
                            className="size-4 shrink-0 text-organization"
                            aria-hidden
                        />
                    )}
                    <span
                        className={`min-w-0 flex-1 whitespace-normal [overflow-wrap:anywhere] ${selected ? "" : "text-muted-foreground"}`}
                    >
                        {(variant === "pill" && selected
                            ? label(selected.folder)
                            : selectedPath) ??
                            placeholder ??
                            i18n("Choose a folder")}
                    </span>
                </>
            }
        >
            {({ query, onQueryChange, close, listRef }) => (
                <FolderSearchList
                    entries={entries}
                    emptyChoiceLabel={emptyChoiceLabel}
                    query={query}
                    onQueryChange={onQueryChange}
                    showPaths
                    listRef={listRef}
                    onEscape={close}
                    onTab={close}
                    onSelect={(folderId) => {
                        if (folderId) rememberFolder(folderId);
                        close();
                        onValueChange(folderId);
                    }}
                    onCreate={
                        onCreate
                            ? (query) => {
                                  close();
                                  onCreate(query);
                              }
                            : undefined
                    }
                />
            )}
        </Combobox>
    );
}
