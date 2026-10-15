"use client";

import { useExtracted } from "next-intl";
import { useEffect, useState } from "react";
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
    open,
    onOpenChange,
    onUpload,
    selectedFolderId,
}: {
    file: File | null;
    folders: readonly UploadFolderOption[];
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onUpload: (folderId: string | null) => void;
    selectedFolderId: string | null;
}) {
    const i18n = useExtracted();
    const [folderId, setFolderId] = useState("");

    useEffect(() => {
        if (!open) return;
        setFolderId(
            selectedFolderId &&
                folders.some((folder) => folder.id === selectedFolderId)
                ? selectedFolderId
                : FILE_LATER,
        );
    }, [folders, open, selectedFolderId]);

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
                            {folders.map((folder) => (
                                <SelectItem key={folder.id} value={folder.id}>
                                    {folder.path}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">
                        {i18n("Create folders from the Folders sidebar.")}
                    </p>
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
