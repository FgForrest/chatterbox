"use client";

import {
    Folder,
    FolderInput,
    FolderPlus,
    List,
    Pencil,
    Users,
    X,
} from "lucide-react";
import { useExtracted } from "next-intl";
import { useId, useMemo, useState } from "react";
import { toast } from "sonner";
import { useConfirm } from "@/components/confirm-dialog";
import { FolderSearchList } from "@/components/recordings/folder-search-list";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogTitle,
} from "@/components/ui/dialog";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { useDashboardRefresh } from "@/hooks/use-dashboard-refresh";
import { useFolderLabel } from "@/hooks/use-folder-label";
import { parseApiError } from "@/lib/api-errors";
import { matchFolders } from "@/lib/folders/navigation";
import type { RecordingFolder } from "@/types/folder";

/** Receiver-only folder mutations use the share version, never the owner's folder routes. */
export async function changeFolderShareRequest(
    id: string,
    version: number,
    action: string,
    fallbackMessage: string,
    values: { name?: string; parentId?: string | null } = {},
) {
    const response = await fetch(
        `/api/folder-shares/${encodeURIComponent(id)}`,
        {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action, version, ...values }),
        },
    );
    if (!response.ok) {
        const error = await parseApiError(response);
        throw new Error(
            error.code === "UNKNOWN_ERROR"
                ? fallbackMessage
                : error.error || fallbackMessage,
        );
    }
}

/** One name and private-placement dialog for accepting, renaming and moving an attachment. */
export function ReceivedFolderDialog({
    shareId,
    version,
    name: initialName,
    ownerName,
    parentId: initialParentId = null,
    action,
    folders,
    open,
    onOpenChange,
    onSaved,
}: {
    shareId: string;
    version: number;
    name: string;
    ownerName: string;
    parentId?: string | null;
    action: "accept" | "rename" | "move";
    folders: RecordingFolder[];
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onSaved?: () => void;
}) {
    const i18n = useExtracted();
    const label = useFolderLabel();
    const refresh = useDashboardRefresh();
    const nameId = useId();
    const [name, setName] = useState(initialName);
    const [parentId, setParentId] = useState(initialParentId);
    const [query, setQuery] = useState("");
    const [saving, setSaving] = useState(false);
    const entries = useMemo(
        () =>
            matchFolders(
                folders.filter(
                    (folder) =>
                        folder.scope === "personal" &&
                        !folder.receivedFolder &&
                        folder.kind !== "public",
                ),
                "",
                label,
            ),
        [folders, label],
    );
    const save = async () => {
        if (saving) return;
        setSaving(true);
        try {
            await changeFolderShareRequest(
                shareId,
                version,
                action,
                i18n("Could not update sharing"),
                { name: name.trim(), parentId },
            );
            onSaved?.();
            onOpenChange(false);
            refresh();
        } catch (error) {
            toast.error(
                error instanceof Error
                    ? error.message
                    : i18n("Could not update sharing"),
            );
        } finally {
            setSaving(false);
        }
    };
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-h-[85dvh] overflow-auto sm:max-w-md">
                <DialogTitle>
                    {action === "accept"
                        ? i18n("Attach shared folder")
                        : action === "rename"
                          ? i18n("Rename for me")
                          : i18n("Move")}
                </DialogTitle>
                <DialogDescription>
                    {action === "accept" && (
                        <span className="mb-1 block font-medium text-foreground">
                            {initialName}
                        </span>
                    )}
                    {i18n("Shared by {owner}", { owner: ownerName })}
                </DialogDescription>
                {action === "accept" && (
                    <ul className="space-y-3 text-sm">
                        <li className="flex gap-3">
                            <FolderPlus className="size-5 shrink-0 text-person-share" />
                            <span>
                                {i18n(
                                    "A new folder appears in your tree. You do not need to prepare an empty one.",
                                )}
                            </span>
                        </li>
                        <li className="flex gap-3">
                            <List className="size-5 shrink-0 text-muted-foreground" />
                            <span>
                                {i18n(
                                    "You see everything directly in it, including what is added later. Subfolders are not shared.",
                                )}
                            </span>
                        </li>
                        <li className="flex gap-3">
                            <Users className="size-5 shrink-0 text-muted-foreground" />
                            <span>
                                {i18n(
                                    "You can add your own recordings and mail too. {owner} and everyone who accepted the folder see them.",
                                    { owner: ownerName },
                                )}
                            </span>
                        </li>
                        <li className="flex gap-3">
                            <Pencil className="size-5 shrink-0 text-muted-foreground" />
                            <span>
                                {i18n(
                                    "The name and position are yours only. Removing the folder ends sharing for you.",
                                )}
                            </span>
                        </li>
                    </ul>
                )}
                {action !== "move" && (
                    <label htmlFor={nameId} className="space-y-2 text-sm">
                        <span>{i18n("Name in your tree")}</span>
                        <Input
                            id={nameId}
                            maxLength={100}
                            value={name}
                            onChange={(event) => setName(event.target.value)}
                            disabled={saving}
                        />
                    </label>
                )}
                {action !== "rename" && (
                    <div className="space-y-2">
                        <p className="text-sm font-medium">
                            {i18n("Place in")}
                        </p>
                        <Button
                            variant="outline"
                            size="sm"
                            aria-pressed={parentId === null}
                            onClick={() => setParentId(null)}
                        >
                            {i18n("Private root")}
                        </Button>
                        <p className="text-sm text-muted-foreground">
                            {parentId
                                ? label(
                                      folders.find(
                                          (folder) => folder.id === parentId,
                                      ) ?? {
                                          name: "",
                                          parentId: null,
                                          kind: "private",
                                          scope: "personal",
                                      },
                                  )
                                : i18n("Private root")}
                        </p>
                        <FolderSearchList
                            entries={entries}
                            query={query}
                            onQueryChange={setQuery}
                            disabled={saving}
                            onSelect={setParentId}
                        />
                        {action === "accept" && (
                            <div className="space-y-2 rounded-lg border bg-muted/20 p-3 text-sm">
                                <p className="text-xs font-medium uppercase text-muted-foreground">
                                    {i18n("Preview")}
                                </p>
                                <p className="flex items-center gap-2">
                                    <Folder className="size-4 text-primary" />
                                    {parentId
                                        ? label(
                                              folders.find(
                                                  (folder) =>
                                                      folder.id === parentId,
                                              ) ?? {
                                                  name: "",
                                                  parentId: null,
                                                  kind: "private",
                                                  scope: "personal",
                                              },
                                          )
                                        : i18n("Private root")}
                                </p>
                                <ul className="ml-2 space-y-1 border-l pl-4">
                                    {folders
                                        .filter(
                                            (folder) =>
                                                folder.parentId ===
                                                (parentId ??
                                                    folders.find(
                                                        (folder) =>
                                                            folder.scope ===
                                                                "personal" &&
                                                            folder.kind ===
                                                                "private",
                                                    )?.id),
                                        )
                                        .map((folder) => (
                                            <li
                                                key={folder.id}
                                                className="flex items-center gap-2"
                                            >
                                                <Folder className="size-4 text-muted-foreground" />
                                                {label(folder)}
                                            </li>
                                        ))}
                                    <li className="flex items-center gap-2 rounded border border-person-share/30 bg-person-share/10 p-2 text-person-share">
                                        <FolderInput className="size-4" />
                                        {name.trim()}
                                        <span className="ml-auto text-xs">
                                            {i18n({
                                                id: "receivedFolder_previewNew",
                                                message: "new",
                                            })}
                                        </span>
                                    </li>
                                </ul>
                            </div>
                        )}
                    </div>
                )}
                {action !== "accept" && (
                    <p className="rounded bg-person-share/10 p-3 text-sm">
                        {i18n(
                            "You see the items directly in the owner's folder, including items added later. Renaming and moving affect only your tree. Removing the folder ends sharing for you.",
                        )}
                    </p>
                )}
                <div className="flex justify-end gap-2">
                    {action === "accept" && (
                        <Button
                            variant="ghost"
                            disabled={saving}
                            onClick={() => onOpenChange(false)}
                        >
                            {i18n("Cancel")}
                        </Button>
                    )}
                    <Button
                        disabled={saving || !name.trim()}
                        onClick={() => void save()}
                    >
                        {action === "accept" ? i18n("Attach") : i18n("Save")}
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
    );
}

/** Attachment menu changes only the receiver's node or ends their invitation. */
export function ReceivedFolderMenu({
    folder,
    onEdit,
}: {
    folder: RecordingFolder;
    onEdit: (action: "rename" | "move") => void;
}) {
    const i18n = useExtracted();
    const confirm = useConfirm();
    const refresh = useDashboardRefresh();
    const share = folder.receivedFolder;
    if (!share) return null;
    return (
        <>
            <DropdownMenuItem onSelect={() => onEdit("rename")}>
                <Pencil />
                {i18n("Rename for me")}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onEdit("move")}>
                <FolderInput />
                {i18n("Move")}
            </DropdownMenuItem>
            <DropdownMenuItem disabled>
                {i18n("Shared by {owner}", { owner: share.ownerName })}
            </DropdownMenuItem>
            <DropdownMenuItem
                variant="destructive"
                onSelect={() => {
                    void confirm({
                        title: i18n("Remove and end sharing"),
                        description: i18n(
                            "This shared folder will disappear from your tree and you will lose access through it. The owner's folder and items stay intact.",
                        ),
                        confirmLabel: i18n("Remove and end sharing"),
                        destructive: true,
                        onConfirm: async () => {
                            await changeFolderShareRequest(
                                share.shareId,
                                share.shareVersion,
                                "remove",
                                i18n("Could not update sharing"),
                            );
                            refresh();
                        },
                    });
                }}
            >
                <X />
                {i18n("Remove and end sharing")}
            </DropdownMenuItem>
        </>
    );
}
