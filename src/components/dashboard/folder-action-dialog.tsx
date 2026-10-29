"use client";

import { useExtracted } from "next-intl";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { useFolderLabel } from "@/hooks/use-folder-label";
import { canManageOrganization } from "@/lib/folders/drag";
import { descendantFolderIds } from "@/lib/folders/hierarchy";
import { joinFolderPath, matchFolders } from "@/lib/folders/navigation";
import { canCreateSubfolder } from "@/lib/folders/permissions";
import type { RecordingFolder } from "@/types/folder";

/** Dedicated create and move dialogs for the header and folder tree entry points. */
export function FolderActionDialog({
    folder,
    folders,
    action,
    open,
    onOpenChange,
    onCreate,
    onMove,
    returnFocusElement,
    canCurate = false,
    isOrgAccount = false,
}: {
    folder: RecordingFolder;
    folders: RecordingFolder[];
    action: "create" | "move";
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onCreate: (parentId: string, name: string) => Promise<void>;
    onMove: (id: string, parentId: string) => Promise<void>;
    returnFocusElement?: HTMLElement | null;
    canCurate?: boolean;
    isOrgAccount?: boolean;
}) {
    const i18n = useExtracted();
    const label = useFolderLabel();
    const [name, setName] = useState("");
    const [parentId, setParentId] = useState(folder.parentId ?? "");
    const [saving, setSaving] = useState(false);
    const subtree = descendantFolderIds(folders, folder.id);
    const entries = matchFolders(folders, "", label).filter(
        (entry) =>
            !entry.folder.receivedFolder &&
            entry.folder.scope === folder.scope &&
            !subtree.has(entry.folder.id),
    );
    const allowed =
        !folder.receivedFolder &&
        (action === "create"
            ? canCreateSubfolder(folder, canCurate, isOrgAccount)
            : folder.kind === "custom" &&
              (folder.scope !== "org" ||
                  canManageOrganization(canCurate, isOrgAccount)));
    if (!allowed) return null;
    const title =
        action === "create" ? i18n("New subfolder") : i18n("Move to…");
    return (
        <Dialog
            open={open}
            onOpenChange={(value) => {
                if (!saving) onOpenChange(value);
            }}
        >
            <DialogContent
                className="sm:max-w-sm"
                onCloseAutoFocus={(event) => {
                    if (returnFocusElement?.isConnected) {
                        event.preventDefault();
                        returnFocusElement.focus();
                    }
                }}
            >
                <DialogHeader>
                    <DialogTitle>{title}</DialogTitle>
                    <DialogDescription>{label(folder)}</DialogDescription>
                </DialogHeader>
                <form
                    className="space-y-4"
                    onSubmit={(event) => {
                        event.preventDefault();
                        if (
                            saving ||
                            (action === "create"
                                ? !name.trim()
                                : !entries.some(
                                      (entry) => entry.folder.id === parentId,
                                  ) || parentId === folder.parentId)
                        )
                            return;
                        setSaving(true);
                        void (
                            action === "create"
                                ? onCreate(folder.id, name.trim())
                                : onMove(folder.id, parentId)
                        )
                            .then(() => onOpenChange(false))
                            .catch(() => {})
                            .finally(() => setSaving(false));
                    }}
                >
                    {action === "create" ? (
                        <Input
                            aria-label={i18n("New subfolder name")}
                            placeholder={i18n("Folder name")}
                            maxLength={100}
                            value={name}
                            onChange={(event) => setName(event.target.value)}
                            disabled={saving}
                        />
                    ) : (
                        <NativeSelect
                            aria-label={i18n("Destination folder")}
                            value={parentId}
                            onChange={(event) =>
                                setParentId(event.target.value)
                            }
                            disabled={saving}
                            className="w-full"
                        >
                            {entries.map((entry) => (
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
                    )}
                    <DialogFooter>
                        <Button
                            variant="outline"
                            type="button"
                            disabled={saving}
                            onClick={() => onOpenChange(false)}
                        >
                            {i18n("Cancel")}
                        </Button>
                        <Button
                            type="submit"
                            disabled={
                                saving ||
                                (action === "create"
                                    ? !name.trim()
                                    : !parentId || parentId === folder.parentId)
                            }
                        >
                            {title}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
