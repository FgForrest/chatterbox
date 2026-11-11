"use client";

import { useExtracted } from "next-intl";
import { useEffect, useState } from "react";
import {
    type CreatedFolder,
    NewFolderForm,
    type NewFolderParent,
} from "@/components/pipeline/new-folder-form";
import { FolderCombobox } from "@/components/recordings/folder-combobox";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { folderDisplayPath } from "@/lib/folders/labels";
import type { FolderScope, RecordingFolder } from "@/types/folder";

const FILE_LATER = "";

export interface UploadFolderOption {
    id: string;
    name: string;
    path: string;
    scope: FolderScope;
    receivedFolder?: RecordingFolder["receivedFolder"];
    restricted?: RecordingFolder["restricted"];
    restricting?: RecordingFolder["restricting"];
    access?: boolean;
}

export function uploadFolderParents(
    folders: readonly RecordingFolder[],
    includeOrganization: boolean,
    folderLabel: (folder: RecordingFolder) => string,
): NewFolderParent[] {
    const byId = new Map(folders.map((folder) => [folder.id, folder]));
    return folders
        .filter(
            (folder) =>
                !folder.receivedFolder &&
                !folder.restricted &&
                !folder.restricting &&
                folder.access !== false &&
                ((folder.scope === "personal" && folder.parentId === null) ||
                    (folder.scope === "org" && includeOrganization)),
        )
        .map((folder) => ({
            id: folder.id,
            path: folderDisplayPath(folder, byId, folderLabel),
            folder,
        }));
}

/** Build non-root picker options with their full visible tree paths. */
export function uploadFolderOptions(
    folders: readonly RecordingFolder[],
    includeOrganization: boolean,
    folderLabel: (folder: RecordingFolder) => string,
): UploadFolderOption[] {
    const byId = new Map(folders.map((folder) => [folder.id, folder]));
    return folders
        .filter(
            (folder) =>
                (folder.receivedFolder || folder.parentId !== null) &&
                (folder.scope === "personal" || includeOrganization),
        )
        .map((folder) => ({
            ...folder,
            path: folderDisplayPath(folder, byId, folderLabel),
        }))
        .sort(
            (left, right) =>
                (left.scope === right.scope
                    ? 0
                    : left.scope === "personal"
                      ? -1
                      : 1) || left.path.localeCompare(right.path),
        );
}

export function UploadDialog({
    file,
    folders,
    folderParents,
    open,
    onOpenChange,
    onUpload,
    onFolderCreated,
    selectedFolderId,
}: {
    file: File | null;
    folders: readonly UploadFolderOption[];
    folderParents: readonly NewFolderParent[];
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onUpload: (folderId: string | null) => void;
    onFolderCreated?: (folder: CreatedFolder) => void;
    selectedFolderId: string | null;
}) {
    const i18n = useExtracted();
    const [folderId, setFolderId] = useState("");
    const [availableFolders, setAvailableFolders] = useState(folders);
    const [newFolderOpen, setNewFolderOpen] = useState(false);
    const [newFolderName, setNewFolderName] = useState("");

    useEffect(() => setAvailableFolders(folders), [folders]);

    useEffect(() => {
        if (!open) return;
        setFolderId(
            selectedFolderId &&
                folders.some(
                    (folder) =>
                        folder.id === selectedFolderId &&
                        folder.access !== false,
                )
                ? selectedFolderId
                : FILE_LATER,
        );
        setNewFolderOpen(false);
    }, [folders, open, selectedFolderId]);

    const handleFolderCreated = (folder: CreatedFolder) => {
        onFolderCreated?.(folder);
        const parent = folderParents.find(
            (candidate) => candidate.id === folder.parentId,
        );
        if (!parent) return;
        setAvailableFolders((current) => [
            ...current,
            {
                ...folder,
                path: `${parent.path} / ${folder.name}`,
                scope: folder.scope,
            },
        ]);
        setFolderId(folder.id);
        setNewFolderOpen(false);
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>{i18n("Upload recording")}</DialogTitle>
                    <DialogDescription>
                        {file?.name ??
                            i18n("Choose where to file this recording.")}
                    </DialogDescription>
                </DialogHeader>
                <div className="grid gap-2 text-sm">
                    <span className="font-medium">{i18n("Folder")}</span>
                    <FolderCombobox
                        aria-label={i18n("Folder")}
                        entries={availableFolders.map((folder) => ({
                            folder: {
                                ...folder,
                                name: folder.name,
                                kind: "custom",
                                parentId: "",
                            },
                            path: folder.path.endsWith(` / ${folder.name}`)
                                ? folder.path.slice(
                                      0,
                                      -` / ${folder.name}`.length,
                                  )
                                : "",
                            depth: 0,
                            nameMatch: true,
                        }))}
                        value={folderId}
                        onValueChange={setFolderId}
                        emptyChoiceLabel={i18n("File later")}
                        onCreate={
                            folderParents.length
                                ? (query) => {
                                      setNewFolderName(query);
                                      setNewFolderOpen(true);
                                  }
                                : undefined
                        }
                    />
                    {newFolderOpen ? (
                        <NewFolderForm
                            initialName={newFolderName}
                            parents={folderParents}
                            idPrefix="upload"
                            onCancel={() => setNewFolderOpen(false)}
                            onCreated={handleFolderCreated}
                        />
                    ) : folderParents.length > 0 ? (
                        <Button
                            type="button"
                            variant="outline"
                            className="w-full"
                            onClick={() => {
                                setNewFolderName("");
                                setNewFolderOpen(true);
                            }}
                        >
                            {i18n("New folder")}
                        </Button>
                    ) : null}
                </div>
                <DialogFooter>
                    <Button
                        type="button"
                        variant="outline"
                        onClick={() => onOpenChange(false)}
                    >
                        {i18n("Cancel")}
                    </Button>
                    <Button
                        type="button"
                        disabled={availableFolders.some(
                            (folder) =>
                                folder.id === folderId &&
                                folder.access === false,
                        )}
                        onClick={() =>
                            onUpload(folderId === FILE_LATER ? null : folderId)
                        }
                    >
                        {i18n("Upload")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
