"use client";

import { FolderInput, FolderPlus } from "lucide-react";
import { useExtracted } from "next-intl";
import { useState } from "react";
import { useItemDetail } from "@/components/items/item-detail-store";
import { ItemFolderChip } from "@/components/items/item-folder-chip";
import { FolderPicker } from "@/components/recordings/folder-picker";
import {
    useWithdrawPreview,
    WithdrawRetentionWarning,
} from "@/components/recordings/withdraw-retention-warning";
import { RestrictedItemAudience } from "@/components/sharing/restricted-item-audience";
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
import { folderDisplayPath } from "@/lib/folders/labels";
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
    const detail = useItemDetail();
    const itemDetail = detail?.itemId === recordingId ? detail : null;
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
    const baseIds = assignments
        .filter((assignment) => assignment.recordingId === recordingId)
        .map((assignment) => assignment.folderId);
    const placements = [
        ...(itemDetail?.projection?.placements ?? []),
        ...(itemDetail?.data?.placements ?? []),
    ];
    const committedIds =
        itemDetail?.projection?.placements.map((folder) => folder.id) ??
        baseIds;
    const assignedIds = new Set(
        itemDetail?.previewFolderIds(committedIds) ?? committedIds,
    );
    const knownFolders = new Map(folders.map((folder) => [folder.id, folder]));
    for (const placement of placements ?? []) {
        const folder = knownFolders.get(placement.id);
        knownFolders.set(placement.id, {
            ...(folder ?? { kind: "custom", sortOrder: 0, version: 0 }),
            ...placement,
            name: folder?.name ?? placement.name,
            restricted: placement.restricted,
            restricting: placement.restricted && folder?.restricting,
            access: placement.access,
        });
    }
    const inScope = (folder: RecordingFolder) =>
        !organizationOnly || folder.scope === "org";
    const assigned = [...knownFolders.values()].filter(
        (folder) =>
            (assignedIds.has(folder.id) ||
                itemDetail?.pendingRemovedFolderIds.has(folder.id)) &&
            inScope(folder) &&
            (isOwn || folder.access !== false),
    );
    const gateIds = new Set(
        itemDetail?.folderIdsForGate(committedIds) ?? committedIds,
    );
    const openOrganizationFolders = [...knownFolders.values()].filter(
        (folder) =>
            gateIds.has(folder.id) &&
            folder.scope === "org" &&
            !folder.restricted &&
            !folder.restricting,
    );
    const assignedOrg = assigned.filter(
        (folder) => folder.scope === "org" && assignedIds.has(folder.id),
    );
    const moveSource =
        !isOwn &&
        onMove &&
        assignedOrg.length === 1 &&
        !assignedOrg[0].restricted &&
        !assignedOrg[0].restricting
            ? assignedOrg[0]
            : null;

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
                    name={
                        folder.restricted
                            ? folderDisplayPath(
                                  folder,
                                  new Map(
                                      folders.map((entry) => [entry.id, entry]),
                                  ),
                                  label,
                              )
                            : label(folder)
                    }
                    restricted={folder.restricted || folder.restricting}
                    organization={folder.scope === "org"}
                    pending={itemDetail?.pendingFolderIds.has(folder.id)}
                    onSelect={() => onSelectFolder(folder)}
                    onRemove={
                        isOwn ||
                        (canWithdraw &&
                            folder.scope === "org" &&
                            !folder.restricted &&
                            !folder.restricting) ||
                        ((typeof canUnfilePersonal === "function"
                            ? canUnfilePersonal(folder)
                            : canUnfilePersonal) &&
                            folder.scope === "personal" &&
                            !folder.receivedFolder)
                            ? () => {
                                  if (
                                      folder.scope === "org" &&
                                      openOrganizationFolders.length === 1 &&
                                      !folder.restricted &&
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
                <FolderPicker
                    folders={folders}
                    canCurate={canCurate}
                    onCreated={onFolderCreated}
                    assignedIds={
                        new Set([
                            ...assignedIds,
                            ...(itemDetail?.pendingRemovedFolderIds ?? []),
                            ...(itemDetail?.data?.intents.map(
                                (intent) => intent.folderId,
                            ) ?? []),
                        ])
                    }
                    open={pickerOpen}
                    closeOnSelect={itemDetail !== null}
                    onOpenChange={setPickerOpen}
                    organizationOnly={organizationOnly || !isOwn}
                    sharing={!organizationOnly && isOwn}
                    title={
                        moveSource ? i18n("Move to…") : i18n("Add to folder")
                    }
                    actionTrigger={
                        <>
                            {moveSource ? (
                                <FolderInput className="size-3.5" />
                            ) : (
                                <FolderPlus className="size-3.5" />
                            )}
                            {moveSource
                                ? i18n("Move to…")
                                : i18n("Add to folder")}
                        </>
                    }
                    onSelect={(folderId) =>
                        moveSource && onMove
                            ? onMove(recordingId, moveSource.id, folderId)
                            : onAdd(recordingId, folderId)
                    }
                />
            )}
            {assigned.some(
                (folder) => folder.restricted || folder.restricting,
            ) && <RestrictedItemAudience itemId={recordingId} />}
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
