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

export interface FolderPickerEnvironment {
    labels: {
        folder: string;
        chooseFolder: string;
        recent: string;
        private: string;
        organization: string;
        shareOrganization: string;
        assigned: string;
        findFolder: string;
        searchFolders: string;
        empty: string;
        newFolder: string;
        createFolder: (name: string) => string;
    };
    label: (folder: FolderSearchEntry["folder"]) => string;
    recentFolders: { id: string }[];
    rememberFolder: (id: string) => void;
}

interface FolderComboboxProps {
    environment?: FolderPickerEnvironment;
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
export function FolderCombobox(props: FolderComboboxProps) {
    return props.environment ? (
        <FolderComboboxBody {...props} environment={props.environment} />
    ) : (
        <AppFolderCombobox {...props} />
    );
}

/** Supply application translations and account-local recent folders to the shared chooser. */
export function useFolderPickerEnvironment(): FolderPickerEnvironment {
    const i18n = useExtracted();
    const label = useFolderLabel();
    const { recentFolders, rememberFolder } = useLibraryPreferences();
    return {
        label,
        recentFolders,
        rememberFolder,
        labels: {
            folder: i18n("Folder"),
            chooseFolder: i18n("Choose a folder"),
            recent: i18n("Recently used"),
            private: i18n("Private"),
            organization: i18n("Organization"),
            shareOrganization: i18n("Share with the Organization"),
            assigned: i18n("Already in this folder"),
            findFolder: i18n("Find a folder…"),
            searchFolders: i18n("Search folders"),
            empty: i18n("No folders match your search."),
            newFolder: i18n("New folder…"),
            createFolder: (name) => i18n("Create folder “{name}”", { name }),
        },
    };
}

function AppFolderCombobox(props: FolderComboboxProps) {
    const environment = useFolderPickerEnvironment();
    return <FolderComboboxBody {...props} environment={environment} />;
}

function FolderComboboxBody({
    environment,
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
}: FolderComboboxProps & { environment: FolderPickerEnvironment }) {
    const { labels, label, rememberFolder } = environment;
    const [saving, setSaving] = useState(false);
    const [creationQuery, setCreationQuery] = useState<string | null>(null);
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
            aria-label={ariaLabel ?? labels.folder}
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
                        className={`min-w-0 flex-1 text-left whitespace-normal [overflow-wrap:anywhere] ${selected ? "" : "text-muted-foreground"}`}
                    >
                        {(variant === "pill" && selected
                            ? label(selected.folder)
                            : selectedPath) ??
                            placeholder ??
                            (value === "" ? emptyChoiceLabel : undefined) ??
                            labels.chooseFolder}
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
                        environment={environment}
                        assignedIds={assignedIds}
                        disabled={saving}
                        sharing={sharing}
                        createOnlyWhenEmpty={createOnlyWhenEmpty}
                        createLabel={
                            createOnlyWhenEmpty
                                ? labels.createFolder(query.trim())
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
