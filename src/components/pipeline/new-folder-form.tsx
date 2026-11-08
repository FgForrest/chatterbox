"use client";

import { useExtracted } from "next-intl";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { FolderCombobox } from "@/components/recordings/folder-combobox";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useFolderLabel } from "@/hooks/use-folder-label";
import { getApiErrorMessage } from "@/lib/api-errors";
import type { RecordingFolder } from "@/types/folder";

export interface NewFolderParent {
    id: string;
    path: string;
    folder?: RecordingFolder;
}

export type CreatedFolder = RecordingFolder;

export function NewFolderForm({
    parents,
    idPrefix,
    onCancel,
    onCreated,
    initialName = "",
    onSavingChange,
}: {
    parents: readonly NewFolderParent[];
    idPrefix: string;
    onCancel: () => void;
    onCreated: (folder: CreatedFolder) => void | Promise<void>;
    initialName?: string;
    onSavingChange?: (saving: boolean) => void;
}) {
    const i18n = useExtracted();
    const folderLabel = useFolderLabel();
    const [name, setName] = useState(initialName);
    const [parentId, setParentId] = useState(parents[0]?.id ?? "");
    const [creating, setCreating] = useState(false);

    useEffect(() => {
        setParentId((current) =>
            parents.some((parent) => parent.id === current)
                ? current
                : (parents[0]?.id ?? ""),
        );
    }, [parents]);

    const createFolder = async () => {
        const trimmedName = name.trim();
        if (creating || !trimmedName || !parentId) return;
        setCreating(true);
        onSavingChange?.(true);
        try {
            const response = await fetch("/api/folders", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ parentId, name: trimmedName }),
            });
            if (!response.ok) {
                toast.error(
                    await getApiErrorMessage(
                        response,
                        i18n("The folder could not be created."),
                    ),
                );
                return;
            }
            const { folder } = (await response.json()) as {
                folder: CreatedFolder;
            };
            await onCreated(folder);
            setName("");
            toast.success(i18n("Folder created."));
        } catch {
            toast.error(i18n("The folder could not be created."));
        } finally {
            setCreating(false);
            onSavingChange?.(false);
        }
    };

    return (
        <div className="space-y-3 border-t pt-3">
            <div className="space-y-1.5">
                <Label htmlFor={`${idPrefix}-new-folder-name`}>
                    {i18n("Folder name")}
                </Label>
                <Input
                    id={`${idPrefix}-new-folder-name`}
                    autoFocus
                    disabled={creating}
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                />
            </div>
            <div className="space-y-1.5">
                <Label>{i18n("Parent folder")}</Label>
                <FolderCombobox
                    entries={parents.map((parent) => ({
                        folder: {
                            id: parent.id,
                            name: parent.path,
                            kind: "custom",
                            scope: "personal",
                            parentId: null,
                            ...parent.folder,
                        },
                        path: parent.folder
                            ? parent.path
                                  .slice(
                                      0,
                                      Math.max(
                                          0,
                                          parent.path.length -
                                              folderLabel(parent.folder).length,
                                      ),
                                  )
                                  .replace(/ [›/] $/, "")
                            : "",
                        depth: 0,
                        nameMatch: true,
                    }))}
                    value={parentId}
                    onValueChange={setParentId}
                    disabled={creating}
                    aria-label={i18n("Parent folder")}
                />
            </div>
            <div className="flex justify-end gap-2">
                <Button
                    type="button"
                    variant="ghost"
                    onClick={onCancel}
                    disabled={creating}
                >
                    {i18n("Cancel")}
                </Button>
                <Button
                    type="button"
                    onClick={() => void createFolder()}
                    disabled={creating || !name.trim() || !parentId}
                >
                    {creating ? i18n("Creating…") : i18n("Create folder")}
                </Button>
            </div>
        </div>
    );
}
