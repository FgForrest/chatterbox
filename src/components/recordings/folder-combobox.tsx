"use client";

import { Folder, Users } from "lucide-react";
import { useExtracted } from "next-intl";
import { type ReactNode, type RefObject, useState } from "react";
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
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    anchorRef?: RefObject<HTMLButtonElement | null>;
    actionTrigger?: ReactNode;
    popupTitle?: string;
    assignedIds?: ReadonlySet<string>;
    sharing?: boolean;
    createOnlyWhenEmpty?: boolean;
    createForm?: (
        query: string,
        back: () => void,
        close: () => void,
    ) => ReactNode;
    entries: FolderSearchEntry[];
    value: string;
    onValueChange: (folderId: string) => void | Promise<void>;
    onCreate?: (query: string) => void;
    disabled?: boolean;
    "aria-label"?: string;
    variant?: "field" | "pill";
    placeholder?: string;
    emptyChoiceLabel?: string;
    className?: string;
}

/** Shared folder chooser with search, recent folders and optional creation. */
export function FolderCombobox({
    open,
    onOpenChange,
    anchorRef,
    actionTrigger,
    popupTitle,
    assignedIds,
    sharing,
    createOnlyWhenEmpty,
    createForm,
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
    const [saving, setSaving] = useState(false);
    const [creationQuery, setCreationQuery] = useState<string | null>(null);
    const label = useFolderLabel();
    const { rememberFolder } = useLibraryPreferences();
    const selected = entries.find((entry) => entry.folder.id === value);
    const selectedPath = selected
        ? joinFolderPath(selected.path, label(selected.folder))
        : undefined;
    return (
        <Combobox
            open={open}
            onOpenChange={(value) => {
                if (!value) setCreationQuery(null);
                onOpenChange?.(value);
            }}
            anchorRef={anchorRef}
            actionTrigger={actionTrigger}
            popupTitle={popupTitle}
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
                            (value === "" ? emptyChoiceLabel : undefined) ??
                            i18n("Choose a folder")}
                    </span>
                </>
            }
        >
            {({ query, onQueryChange, close, listRef }) =>
                creationQuery !== null && createForm ? (
                    createForm(
                        creationQuery,
                        () => setCreationQuery(null),
                        close,
                    )
                ) : (
                    <FolderSearchList
                        assignedIds={assignedIds}
                        disabled={saving}
                        sharing={sharing}
                        createOnlyWhenEmpty={createOnlyWhenEmpty}
                        createLabel={
                            createOnlyWhenEmpty
                                ? i18n("Create folder “{name}”", {
                                      name: query.trim(),
                                  })
                                : undefined
                        }
                        entries={entries}
                        emptyChoiceLabel={emptyChoiceLabel}
                        query={query}
                        onQueryChange={onQueryChange}
                        showPaths
                        listRef={listRef}
                        onEscape={close}
                        onTab={close}
                        onSelect={async (folderId) => {
                            if (saving || assignedIds?.has(folderId)) return;
                            setSaving(true);
                            try {
                                const result = onValueChange(folderId);
                                if (result) await result;
                                if (folderId) rememberFolder(folderId);
                                close();
                            } catch {
                            } finally {
                                setSaving(false);
                            }
                        }}
                        onCreate={
                            createForm || onCreate
                                ? (query) => {
                                      if (createForm) {
                                          setCreationQuery(query);
                                          return;
                                      }
                                      close();
                                      onCreate?.(query);
                                  }
                                : undefined
                        }
                    />
                )
            }
        </Combobox>
    );
}
