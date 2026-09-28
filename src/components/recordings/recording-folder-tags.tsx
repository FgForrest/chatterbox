"use client";

import { Folder, FolderInput, FolderPlus, Users, X } from "lucide-react";
import { useExtracted } from "next-intl";
import { useState } from "react";
import { WithdrawRetentionWarning } from "@/components/recordings/withdraw-retention-warning";
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
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type {
    RecordingFolder,
    RecordingFolderAssignment,
} from "@/types/folder";

interface RecordingFolderTagsProps {
    recordingId: string;
    folders: RecordingFolder[];
    assignments: RecordingFolderAssignment[];
    onSelectFolder: (folder: RecordingFolder) => void;
    onAdd: (recordingId: string, folderId: string) => Promise<void>;
    onRemove: (recordingId: string, folderId: string) => Promise<void>;
    /**
     * Whether the viewer owns the recording. Only the owner files it in
     * Private folders or shares it with (and withdraws it from) the
     * Organization; anyone else may only move it within the Organization.
     */
    isOwn?: boolean;
    /** Show only Organization folders (the recording's Organization view). */
    organizationOnly?: boolean;
    onMove?: (
        recordingId: string,
        fromFolderId: string,
        toFolderId: string,
    ) => Promise<void>;
}

export function RecordingFolderTags({
    recordingId,
    folders,
    assignments,
    onSelectFolder,
    onAdd,
    onRemove,
    isOwn = true,
    organizationOnly = false,
    onMove,
}: RecordingFolderTagsProps) {
    const i18n = useExtracted();
    // The Organization folder whose removal would withdraw the recording,
    // while its owner confirms.
    const [withdrawing, setWithdrawing] = useState<RecordingFolder | null>(
        null,
    );
    const label = (folder: RecordingFolder) =>
        folder.parentId === null && folder.scope === "org"
            ? i18n("Organization")
            : folder.name;
    const assignedIds = new Set(
        assignments
            .filter((assignment) => assignment.recordingId === recordingId)
            .map((assignment) => assignment.folderId),
    );
    const inScope = (folder: RecordingFolder) =>
        !organizationOnly || folder.scope === "org";
    const assigned = folders.filter(
        (folder) => assignedIds.has(folder.id) && inScope(folder),
    );
    const unassigned = folders.filter(
        (folder) =>
            folder.kind !== "private" &&
            !assignedIds.has(folder.id) &&
            inScope(folder),
    );
    const personalAvailable = unassigned.filter(
        (folder) => folder.scope !== "org",
    );
    const orgAvailable = unassigned.filter((folder) => folder.scope === "org");
    const assignedOrg = assigned.filter((folder) => folder.scope === "org");
    // Someone else's recording can be refiled but not shared or withdrawn,
    // and refiling needs to know which folder it leaves.
    const moveSource =
        !isOwn && onMove && assignedOrg.length === 1 ? assignedOrg[0] : null;

    return (
        <fieldset className="flex min-w-0 flex-wrap items-center gap-2 border-0 p-0">
            <legend className="sr-only">{i18n("Folders")}</legend>
            {assigned.map((folder) => (
                <span
                    key={folder.id}
                    className="inline-flex h-7 items-center overflow-hidden rounded-full border border-primary/20 bg-primary/5 text-xs"
                >
                    <button
                        type="button"
                        onClick={() => onSelectFolder(folder)}
                        className="inline-flex h-full items-center gap-1.5 px-2.5 text-foreground hover:bg-primary/10"
                    >
                        {folder.scope === "org" ? (
                            <Users className="size-3.5 text-primary" />
                        ) : (
                            <Folder className="size-3.5 text-primary" />
                        )}
                        {label(folder)}
                    </button>
                    {isOwn && (
                        <button
                            type="button"
                            onClick={() => {
                                // Its last Organization folder: leaving it
                                // withdraws the recording, which is
                                // confirmed first.
                                if (
                                    folder.scope === "org" &&
                                    assignedOrg.length === 1
                                ) {
                                    setWithdrawing(folder);
                                    return;
                                }
                                void onRemove(recordingId, folder.id).catch(
                                    () => {},
                                );
                            }}
                            className="inline-flex h-full items-center border-l border-primary/15 px-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                            aria-label={i18n("Remove from {folder}", {
                                folder: label(folder),
                            })}
                        >
                            <X className="size-3.5" />
                        </button>
                    )}
                </span>
            ))}
            {isOwn && (
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-7 rounded-full border border-dashed px-2.5 text-xs text-muted-foreground"
                        >
                            <FolderPlus className="size-3.5" />{" "}
                            {i18n("Add to folder")}
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent
                        align="start"
                        className="max-h-72 overflow-y-auto"
                    >
                        {personalAvailable.length > 0 && (
                            <DropdownMenuLabel>
                                {i18n("Folders")}
                            </DropdownMenuLabel>
                        )}
                        {personalAvailable.map((folder) => (
                            <DropdownMenuItem
                                key={folder.id}
                                onSelect={() => {
                                    void onAdd(recordingId, folder.id).catch(
                                        () => {},
                                    );
                                }}
                            >
                                <Folder />
                                {label(folder)}
                            </DropdownMenuItem>
                        ))}
                        {orgAvailable.length > 0 && (
                            <>
                                {personalAvailable.length > 0 && (
                                    <DropdownMenuSeparator />
                                )}
                                <DropdownMenuLabel>
                                    {i18n("Share with the Organization")}
                                </DropdownMenuLabel>
                                {orgAvailable.map((folder) => (
                                    <DropdownMenuItem
                                        key={folder.id}
                                        onSelect={() => {
                                            void onAdd(
                                                recordingId,
                                                folder.id,
                                            ).catch(() => {});
                                        }}
                                    >
                                        <Users />
                                        {label(folder)}
                                    </DropdownMenuItem>
                                ))}
                            </>
                        )}
                        {unassigned.length === 0 && (
                            <DropdownMenuItem disabled>
                                {i18n("No other folders")}
                            </DropdownMenuItem>
                        )}
                    </DropdownMenuContent>
                </DropdownMenu>
            )}
            {moveSource && onMove && orgAvailable.length > 0 && (
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-7 rounded-full border border-dashed px-2.5 text-xs text-muted-foreground"
                        >
                            <FolderInput className="size-3.5" />{" "}
                            {i18n("Move to…")}
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent
                        align="start"
                        className="max-h-72 overflow-y-auto"
                    >
                        {orgAvailable.map((folder) => (
                            <DropdownMenuItem
                                key={folder.id}
                                onSelect={() => {
                                    void onMove(
                                        recordingId,
                                        moveSource.id,
                                        folder.id,
                                    ).catch(() => {});
                                }}
                            >
                                <Users />
                                {label(folder)}
                            </DropdownMenuItem>
                        ))}
                    </DropdownMenuContent>
                </DropdownMenu>
            )}
            <Dialog
                open={withdrawing !== null}
                onOpenChange={(open) => {
                    if (!open) setWithdrawing(null);
                }}
            >
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>
                            {i18n(
                                "Take this recording out of the Organization?",
                            )}
                        </DialogTitle>
                        <DialogDescription>
                            {i18n(
                                "Colleagues will no longer see it. You get it back as the Organization left it, and can change it again.",
                            )}
                        </DialogDescription>
                    </DialogHeader>
                    {withdrawing && (
                        <WithdrawRetentionWarning recordingId={recordingId} />
                    )}
                    <DialogFooter>
                        <Button
                            variant="outline"
                            onClick={() => setWithdrawing(null)}
                        >
                            {i18n("Cancel")}
                        </Button>
                        <Button
                            onClick={() => {
                                const folder = withdrawing;
                                setWithdrawing(null);
                                if (folder) {
                                    void onRemove(recordingId, folder.id).catch(
                                        () => {},
                                    );
                                }
                            }}
                        >
                            {i18n("Take out of the Organization")}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </fieldset>
    );
}
