"use client";

import { useExtracted } from "next-intl";
import {
    type CreatedFolder,
    NewFolderForm,
} from "@/components/pipeline/new-folder-form";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import type { RecordingFolder } from "@/types/folder";

interface Props {
    folders: readonly RecordingFolder[];
    includeOrganization: boolean;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onCreated: (folder: CreatedFolder) => void;
}

/** Create a folder directly inside an available library root. */
export function FirstLevelFolderDialog({
    folders,
    includeOrganization,
    open,
    onOpenChange,
    onCreated,
}: Props) {
    const i18n = useExtracted();
    const parents = folders
        .filter(
            (folder) =>
                folder.parentId === null &&
                (folder.scope === "personal" || includeOrganization),
        )
        .map((folder) => ({
            id: folder.id,
            path: folder.scope === "org" ? i18n("Organization") : folder.name,
        }));

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>{i18n("New folder")}</DialogTitle>
                    <DialogDescription>
                        {i18n("Create a folder for your recordings.")}
                    </DialogDescription>
                </DialogHeader>
                <NewFolderForm
                    parents={parents}
                    idPrefix="first-level"
                    onCancel={() => onOpenChange(false)}
                    onCreated={(folder) => {
                        onCreated(folder);
                        onOpenChange(false);
                    }}
                />
            </DialogContent>
        </Dialog>
    );
}
