"use client";

import { FolderInput, FolderPlus } from "lucide-react";
import { useExtracted } from "next-intl";
import { useState } from "react";
import { ItemFolderChip } from "@/components/items/item-folder-chip";
import { FolderPicker } from "@/components/recordings/folder-picker";
import {
    useWithdrawPreview,
    WithdrawRetentionWarning,
} from "@/components/recordings/withdraw-retention-warning";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { useFolderLabel } from "@/hooks/use-folder-label";
import type {
    RecordingFolder,
    RecordingFolderAssignment,
} from "@/types/folder";

interface RecordingFolderTagsProps {
    canCurate?: boolean;
    onFolderCreated?: (folder: RecordingFolder) => void;
    recordingId: string;
    kind?: "audio" | "mail" | "meeting";
    folders: RecordingFolder[];
    assignments: RecordingFolderAssignment[];
    onSelectFolder: (folder: RecordingFolder) => void;
    onAdd: (recordingId: string, folderId: string) => Promise<void>;
    /**
     * `withdraw`: the owner confirmed that leaving the last Organization
     * folder takes the recording out of the Organization. A removal the
     * server finds to be that one without it rejects with an error whose
     * `code` is `WITHDRAW_UNCONFIRMED`, and the confirmation opens.
     */
    onRemove: (
        recordingId: string,
        folderId: string,
        withdraw?: boolean,
    ) => Promise<void>;
    /**
     * Whether the viewer owns the recording. Only the owner files it in
     * Private folders or shares it with (and withdraws it from) the
     * Organization; every viewer may move it within the Organization.
     */
    isOwn?: boolean;
    /**
     * Whether the viewer may take it out of Organization folders, down to
     * withdrawing it: its owner, and the organization account on the
     * Organization view, who confirms the owner's retention warning.
     */
    canWithdraw?: boolean;
    canUnfilePersonal?: boolean | ((folder: RecordingFolder) => boolean);
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
    kind = "audio",
    folders,
    assignments,
    onSelectFolder,
    onAdd,
    onRemove,
    isOwn = true,
    canWithdraw = isOwn,
    canUnfilePersonal = false,
    organizationOnly = false,
    onMove,
    canCurate,
    onFolderCreated,
}: RecordingFolderTagsProps) {
    const i18n = useExtracted();
    const [pickerOpen, setPickerOpen] = useState(false);
    // The Organization folder whose removal would withdraw the recording,
    // while its owner confirms.
    const [withdrawing, setWithdrawing] = useState<RecordingFolder | null>(
        null,
    );
    // The owner asks on their own view, the organization account on the
    // Organization's.
    const preview = useWithdrawPreview(
        withdrawing && kind !== "meeting" ? recordingId : null,
        isOwn ? "private" : "org",
    );
    const label = useFolderLabel();
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
    const assignedOrg = assigned.filter((folder) => folder.scope === "org");
    const moveSource =
        !isOwn && onMove && assignedOrg.length === 1 ? assignedOrg[0] : null;

    const hasMoveTarget =
        moveSource &&
        folders.some(
            (folder) =>
                folder.scope === "org" &&
                folder.kind !== "private" &&
                !assignedIds.has(folder.id),
        );

    return (
        <fieldset className="flex min-w-0 flex-wrap items-center gap-2 border-0 p-0">
            <legend className="sr-only">{i18n("Folders")}</legend>
            {assigned.map((folder) => (
                <ItemFolderChip
                    key={folder.id}
                    name={label(folder)}
                    organization={folder.scope === "org"}
                    onSelect={() => onSelectFolder(folder)}
                    onRemove={
                        isOwn ||
                        (canWithdraw && folder.scope === "org") ||
                        ((typeof canUnfilePersonal === "function"
                            ? canUnfilePersonal(folder)
                            : canUnfilePersonal) &&
                            folder.scope === "personal" &&
                            !folder.receivedFolder)
                            ? () => {
                                  if (
                                      folder.scope === "org" &&
                                      assignedOrg.length === 1 &&
                                      kind !== "meeting"
                                  ) {
                                      setWithdrawing(folder);
                                      return;
                                  }
                                  void (
                                      kind === "meeting"
                                          ? onRemove(
                                                recordingId,
                                                folder.id,
                                                true,
                                            )
                                          : onRemove(recordingId, folder.id)
                                  ).catch((error: unknown) => {
                                      if (
                                          (error as { code?: unknown })
                                              ?.code === "WITHDRAW_UNCONFIRMED"
                                      )
                                          setWithdrawing(folder);
                                  });
                              }
                            : undefined
                    }
                />
            ))}
            {(isOwn || hasMoveTarget) && (
                <>
                    <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 rounded-full border border-dashed px-2.5 text-xs text-muted-foreground"
                        onClick={() => setPickerOpen(true)}
                    >
                        {moveSource ? (
                            <FolderInput className="size-3.5" />
                        ) : (
                            <FolderPlus className="size-3.5" />
                        )}
                        {moveSource ? i18n("Move to…") : i18n("Add to folder")}
                    </Button>
                    {pickerOpen && (
                        <FolderPicker
                            folders={folders}
                            canCurate={canCurate}
                            onCreated={onFolderCreated}
                            assignedIds={assignedIds}
                            open={pickerOpen}
                            onOpenChange={setPickerOpen}
                            organizationOnly={organizationOnly || !isOwn}
                            sharing={!organizationOnly && isOwn}
                            onSelect={(folderId) =>
                                moveSource && onMove
                                    ? onMove(
                                          recordingId,
                                          moveSource.id,
                                          folderId,
                                      )
                                    : onAdd(recordingId, folderId)
                            }
                        />
                    )}
                </>
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
                            {kind === "mail"
                                ? i18n(
                                      "Take this mail out of the Organization?",
                                  )
                                : i18n(
                                      "Take this recording out of the Organization?",
                                  )}
                        </DialogTitle>
                        <DialogDescription>
                            {isOwn
                                ? i18n(
                                      "Colleagues will no longer see it. You get it back as the Organization left it, and can change it again.",
                                  )
                                : i18n(
                                      "Colleagues will no longer see it. Its owner gets it back as the Organization left it.",
                                  )}
                        </DialogDescription>
                    </DialogHeader>
                    {withdrawing && kind !== "meeting" && (
                        <WithdrawRetentionWarning
                            preview={preview}
                            ofOwner={!isOwn}
                            kind={kind}
                        />
                    )}
                    <DialogFooter>
                        <Button
                            variant="outline"
                            onClick={() => setWithdrawing(null)}
                        >
                            {i18n("Cancel")}
                        </Button>
                        <Button
                            // What the owner's retention will delete is
                            // part of what is confirmed.
                            disabled={preview.status === "loading"}
                            onClick={() => {
                                const folder = withdrawing;
                                setWithdrawing(null);
                                if (folder) {
                                    void onRemove(
                                        recordingId,
                                        folder.id,
                                        true,
                                    ).catch(() => {});
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
