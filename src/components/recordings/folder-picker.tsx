"use client";

import { useExtracted } from "next-intl";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { FolderSearchList } from "@/components/recordings/folder-search-list";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogTitle,
} from "@/components/ui/dialog";
import { NativeSelect } from "@/components/ui/native-select";
import { useFolderLabel } from "@/hooks/use-folder-label";
import { useLibraryPreferences } from "@/hooks/use-library-preferences";
import { getApiErrorMessage } from "@/lib/api-errors";
import { joinFolderPath, matchFolders } from "@/lib/folders/navigation";
import type { RecordingFolder } from "@/types/folder";

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
}) {
    const i18n = useExtracted();
    const label = useFolderLabel();
    const { rememberFolder } = useLibraryPreferences();
    const [query, setQuery] = useState("");
    const [creating, setCreating] = useState(false);
    const [parentId, setParentId] = useState("");
    const [saving, setSaving] = useState(false);
    const entries = useMemo(
        () =>
            matchFolders(
                folders.filter(
                    (folder) =>
                        !folder.receivedFolder &&
                        (!organizationOnly || folder.scope === "org") &&
                        (!scope || folder.scope === scope),
                ),
                "",
                label,
            ),
        [folders, organizationOnly, scope, label],
    );
    const parents = entries.filter(
        ({ folder }) =>
            folder.scope !== "org" || folder.parentId !== null || canCurate,
    );
    const select = async (folderId: string) => {
        if (assignedIds.has(folderId) || saving) return;
        setSaving(true);
        try {
            await onSelect(folderId);
            rememberFolder(folderId);
            onOpenChange(false);
        } catch {
        } finally {
            setSaving(false);
        }
    };
    const create = async () => {
        if (!parentId || !query.trim() || saving) return;
        setSaving(true);
        try {
            const response = await fetch("/api/folders", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ parentId, name: query.trim() }),
            });
            if (!response.ok)
                throw new Error(
                    await getApiErrorMessage(
                        response,
                        i18n("Could not create folder"),
                    ),
                );
            const { folder } = (await response.json()) as {
                folder: RecordingFolder;
            };
            onCreated?.(folder);
            setCreating(false);
            try {
                await onSelect(folder.id);
                rememberFolder(folder.id);
                onOpenChange(false);
            } catch {}
        } catch (error) {
            toast.error(
                error instanceof Error
                    ? error.message
                    : i18n("Could not create folder"),
            );
        } finally {
            setSaving(false);
        }
    };
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent
                onKeyDown={(event) => {
                    if (["j", "k", "/"].includes(event.key))
                        event.stopPropagation();
                }}
                className="top-[15vh] max-h-[80dvh] -translate-y-0 overflow-y-auto gap-3 p-4 sm:max-w-md"
            >
                <DialogTitle>{title ?? i18n("Choose a folder")}</DialogTitle>
                <DialogDescription className="sr-only">
                    {i18n("Search by folder name or path.")}
                </DialogDescription>
                {creating ? (
                    <div className="space-y-3">
                        <p>
                            {i18n("Create folder “{name}”", {
                                name: query.trim(),
                            })}
                        </p>
                        <NativeSelect
                            aria-label={i18n("Parent folder")}
                            value={parentId}
                            onChange={(event) =>
                                setParentId(event.target.value)
                            }
                            className="w-full"
                        >
                            {parents.map((entry) => (
                                <option
                                    key={entry.folder.id}
                                    value={entry.folder.id}
                                >
                                    {joinFolderPath(
                                        entry.path,
                                        label(entry.folder),
                                    )}
                                </option>
                            ))}
                        </NativeSelect>
                        <div className="flex justify-end gap-2">
                            <Button
                                variant="outline"
                                onClick={() => setCreating(false)}
                            >
                                {i18n("Back")}
                            </Button>
                            <Button
                                disabled={!parentId || saving}
                                onClick={() => void create()}
                            >
                                {i18n("Create folder")}
                            </Button>
                        </div>
                    </div>
                ) : (
                    <FolderSearchList
                        entries={entries.filter(
                            ({ folder }) => folder.kind !== "private",
                        )}
                        query={query}
                        onQueryChange={setQuery}
                        assignedIds={assignedIds}
                        disabled={saving}
                        sharing={sharing}
                        onSelect={(folderId) => void select(folderId)}
                        createOnlyWhenEmpty
                        createLabel={i18n("Create folder “{name}”", {
                            name: query.trim(),
                        })}
                        onCreate={
                            parents.length > 0
                                ? () => {
                                      setParentId(parents[0]?.folder.id ?? "");
                                      setCreating(true);
                                  }
                                : undefined
                        }
                    />
                )}
            </DialogContent>
        </Dialog>
    );
}
