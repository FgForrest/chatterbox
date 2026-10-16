"use client";

import { useExtracted } from "next-intl";
import { useEffect, useState } from "react";
import {
    type CreatedFolder,
    NewFolderForm,
    type NewFolderParent,
} from "@/components/pipeline/new-folder-form";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import type { FolderScope, RecordingFolder } from "@/types/folder";

const FILE_LATER = "__file_later__";

export interface UploadFolderOption {
    id: string;
    name: string;
    path: string;
    scope: FolderScope;
}

export function uploadFolderParents(
    folders: readonly RecordingFolder[],
    includeOrganization: boolean,
): NewFolderParent[] {
    const byId = new Map(folders.map((folder) => [folder.id, folder]));
    return folders
        .filter(
            (folder) =>
                (folder.scope === "personal" && folder.parentId === null) ||
                (folder.scope === "org" && includeOrganization),
        )
        .map((folder) => {
            const names = [folder.name];
            const seen = new Set([folder.id]);
            let parentId = folder.parentId;
            while (parentId && !seen.has(parentId)) {
                seen.add(parentId);
                const parent = byId.get(parentId);
                if (!parent) break;
                names.unshift(parent.name);
                parentId = parent.parentId;
            }
            return { id: folder.id, path: names.join(" / ") };
        });
}

/** Build non-root picker options with their full visible tree paths. */
export function uploadFolderOptions(
    folders: readonly RecordingFolder[],
    includeOrganization: boolean,
): UploadFolderOption[] {
    const byId = new Map(folders.map((folder) => [folder.id, folder]));
    return folders
        .filter(
            (folder) =>
                folder.parentId !== null &&
                (folder.scope === "personal" || includeOrganization),
        )
        .map((folder) => {
            const names = [folder.name];
            const seen = new Set([folder.id]);
            let parentId = folder.parentId;
            while (parentId && !seen.has(parentId)) {
                seen.add(parentId);
                const parent = byId.get(parentId);
                if (!parent) break;
                names.unshift(parent.name);
                parentId = parent.parentId;
            }
            return { ...folder, path: names.join(" / ") };
        })
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

    useEffect(() => setAvailableFolders(folders), [folders]);

    useEffect(() => {
        if (!open) return;
        setFolderId(
            selectedFolderId &&
                folders.some((folder) => folder.id === selectedFolderId)
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
                id: folder.id,
                name: folder.name,
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
                    <Select value={folderId} onValueChange={setFolderId}>
                        <SelectTrigger
                            id="upload-folder"
                            className="w-full"
                            aria-label={i18n("Folder")}
                        >
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value={FILE_LATER}>
                                {i18n("File later")}
                            </SelectItem>
                            {availableFolders.map((folder) => (
                                <SelectItem key={folder.id} value={folder.id}>
                                    {folder.path}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                    {newFolderOpen ? (
                        <NewFolderForm
                            parents={folderParents}
                            idPrefix="upload"
                            onCancel={() => setNewFolderOpen(false)}
                            onCreated={handleFolderCreated}
                        />
                    ) : (
                        <Button
                            type="button"
                            variant="outline"
                            className="w-full"
                            disabled={folderParents.length === 0}
                            onClick={() => setNewFolderOpen(true)}
                        >
                            {i18n("New folder")}
                        </Button>
                    )}
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
