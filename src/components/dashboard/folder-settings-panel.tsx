"use client";

import { Trash2 } from "lucide-react";
import { useExtracted } from "next-intl";
import { type ComponentProps, useMemo, useState } from "react";
import { useConfirm } from "@/components/confirm-dialog";
import { FolderDefaultProfiles } from "@/components/dashboard/folder-default-profiles";
import {
    FolderExportActions,
    type FolderExportStatus,
} from "@/components/dashboard/folder-export-actions";
import {
    FolderDeletionAddresses,
    FolderMailAddresses,
} from "@/components/mail/folder-mail-addresses";
import {
    PersonShareDialog,
    usePersonSharing,
} from "@/components/sharing/person-sharing";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useFolderExportLabel } from "@/hooks/use-folder-export-label";
import { useFolderLabel } from "@/hooks/use-folder-label";
import type { ExportProvidersAvailability } from "@/lib/folder-exports/types";
import { canManageOrganization } from "@/lib/folders/drag";
import { ancestorFolderIds } from "@/lib/folders/hierarchy";
import { joinFolderPath, matchFolders } from "@/lib/folders/navigation";
import type { RecordingFolder } from "@/types/folder";

/** Settings for a folder the viewer owns or curates; received attachments have none. */
export function FolderSettingsPanel(
    props: ComponentProps<typeof OwnedFolderSettingsPanel>,
) {
    if (props.folder.receivedFolder) return null;
    return <OwnedFolderSettingsPanel {...props} />;
}

function OwnedFolderSettingsPanel({
    folder,
    folders,
    count,
    open,
    onOpenChange,
    onRename,
    onDelete,
    exportProviders,
    mailEnabled = false,
    canCurate = false,
    isOrgAccount = false,
    reopenExport,
    onReopenHandled,
}: {
    folder: RecordingFolder;
    folders: RecordingFolder[];
    count: number;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onRename: (id: string, name: string) => Promise<void>;
    onDelete: (id: string) => Promise<void>;
    exportProviders: ExportProvidersAvailability;
    mailEnabled?: boolean;
    canCurate?: boolean;
    isOrgAccount?: boolean;
    reopenExport?: "form" | "list";
    onReopenHandled?: () => void;
}) {
    const i18n = useExtracted();
    const sharingEnabled = usePersonSharing();
    const label = useFolderLabel();
    const confirm = useConfirm();
    const [name, setName] = useState(folder.name);
    const [renaming, setRenaming] = useState(false);
    const [exportStatus, setExportStatus] = useState<FolderExportStatus>({
        configured: [],
        loading: true,
        failed: false,
        inheritedFolderId: null,
    });
    const exports = exportStatus.configured;
    const exportLabel = useFolderExportLabel();
    const [saving, setSaving] = useState(false);
    const [exportOpen, setExportOpen] = useState(false);
    const [exportPicking, setExportPicking] = useState(false);
    const canManage =
        folder.scope !== "org" ||
        canManageOrganization(canCurate, isOrgAccount);
    const exportAncestors = useMemo(
        () =>
            [...ancestorFolderIds(folders, folder.id)]
                .slice(1)
                .flatMap((id) => folders.find((item) => item.id === id) ?? []),
        [folders, folder.id],
    );
    const root = exportAncestors.at(-1) ?? folder;
    const privateTree =
        root.kind === "private" || (isOrgAccount && root.kind === "public");
    const inheritedExportFolder = folders.find(
        (item) => item.id === exportStatus.inheritedFolderId,
    );
    const entries = matchFolders(folders, "", label);
    const path = joinFolderPath(
        entries.find((entry) => entry.folder.id === folder.id)?.path,
        label(folder),
    );
    const save = async (action: () => Promise<void>) => {
        setSaving(true);
        try {
            await action();
        } catch {
        } finally {
            setSaving(false);
        }
    };
    return (
        <>
            <Dialog
                open={open && !exportOpen && !exportPicking}
                onOpenChange={onOpenChange}
            >
                <DialogContent
                    className="max-h-[85dvh] overflow-y-auto sm:max-w-xl"
                    onOpenAutoFocus={(event) => event.preventDefault()}
                >
                    <DialogHeader>
                        <DialogTitle>{label(folder)}</DialogTitle>
                        <DialogDescription>
                            {path} ·{" "}
                            {i18n(
                                "{count, plural, one {# item} other {# items}}",
                                {
                                    count,
                                },
                            )}
                        </DialogDescription>
                    </DialogHeader>
                    <div className="flex items-start justify-between gap-3 border-t pt-3">
                        <div className="min-w-0 flex-1 text-sm">
                            <h3 className="font-medium">{i18n("Name")}</h3>
                            {renaming ? (
                                <Input
                                    aria-label={i18n("Folder name")}
                                    value={name}
                                    disabled={saving}
                                    maxLength={100}
                                    onChange={(event) =>
                                        setName(event.target.value)
                                    }
                                />
                            ) : (
                                <p className="text-muted-foreground">
                                    {label(folder)}
                                </p>
                            )}
                        </div>
                        {folder.kind === "custom" && canManage && (
                            <Button
                                variant="outline"
                                disabled={saving || (renaming && !name.trim())}
                                onClick={() =>
                                    renaming
                                        ? void save(async () => {
                                              await onRename(
                                                  folder.id,
                                                  name.trim(),
                                              );
                                              setRenaming(false);
                                          })
                                        : setRenaming(true)
                                }
                            >
                                {renaming ? i18n("Save") : i18n("Rename")}
                            </Button>
                        )}
                    </div>
                    {sharingEnabled &&
                        folder.scope === "personal" &&
                        folder.kind === "custom" && (
                            <section className="border-t pt-3">
                                <PersonShareDialog
                                    itemId={folder.id}
                                    title={folder.name}
                                    kind="folder"
                                    open={open}
                                    onOpenChange={() => {}}
                                    inline
                                />
                            </section>
                        )}
                    {mailEnabled && folder.kind === "custom" && (
                        <FolderMailAddresses
                            folderId={folder.id}
                            readOnly={!canManage}
                        />
                    )}
                    {folder.kind === "custom" && (
                        <section className="border-t pt-3">
                            <FolderDefaultProfiles
                                folderId={folder.id}
                                readOnly={!canManage}
                            />
                        </section>
                    )}
                    <section className="flex items-start justify-between gap-3 border-t pt-3">
                        <div className="min-w-0 text-sm">
                            <h3 className="font-medium">{i18n("Export")}</h3>
                            <p className="break-words text-muted-foreground">
                                {exportStatus.loading
                                    ? i18n("Loading…")
                                    : exportStatus.failed
                                      ? i18n("Could not load folder exports.")
                                      : exports.length
                                        ? exports.map(exportLabel).join(", ")
                                        : inheritedExportFolder
                                          ? i18n("Inherited from {folder}", {
                                                folder: label(
                                                    inheritedExportFolder,
                                                ),
                                            })
                                          : i18n("Not configured")}
                                {exports.length > 0 &&
                                    inheritedExportFolder && (
                                        <>
                                            {" "}
                                            ·{" "}
                                            {i18n("Inherited from {folder}", {
                                                folder: label(
                                                    inheritedExportFolder,
                                                ),
                                            })}
                                        </>
                                    )}
                            </p>
                        </div>
                        {canManage && (
                            <Button
                                variant="outline"
                                onClick={() => setExportOpen(true)}
                            >
                                {exports.length
                                    ? i18n("Change")
                                    : i18n("Configure")}
                            </Button>
                        )}
                    </section>
                    {folder.kind === "custom" && canManage && (
                        <div className="border-t pt-3">
                            <Button
                                variant="destructive"
                                disabled={saving}
                                onClick={() => {
                                    void confirm({
                                        title: i18n("Delete “{name}”?", {
                                            name: folder.name,
                                        }),
                                        description: (
                                            <>
                                                <p>
                                                    {folder.scope === "org"
                                                        ? i18n(
                                                              "This folder and all its subfolders will be deleted for everyone. Their recordings stay shared and move to the Organization folder.",
                                                          )
                                                        : i18n(
                                                              "This folder and all its subfolders will be deleted. Recordings stay intact; only their folder assignments are removed.",
                                                          )}
                                                </p>
                                                {mailEnabled && (
                                                    <FolderDeletionAddresses
                                                        folderId={folder.id}
                                                    />
                                                )}
                                            </>
                                        ),
                                        confirmLabel: i18n("Delete folder"),
                                        pendingLabel: i18n("Deleting…"),
                                        destructive: true,
                                        onConfirm: async () => {
                                            await onDelete(folder.id);
                                            onOpenChange(false);
                                        },
                                    });
                                }}
                            >
                                <Trash2 className="size-4" />
                                {i18n("Delete folder")}
                            </Button>
                        </div>
                    )}
                </DialogContent>
            </Dialog>
            <FolderExportActions
                folder={folder}
                providers={exportProviders}
                privateTree={privateTree || folder.scope === "org"}
                readOnly={!canManage}
                ancestors={exportAncestors}
                open={exportOpen}
                onOpenChange={setExportOpen}
                onPickerChange={setExportPicking}
                hideTrigger
                reopen={reopenExport}
                onReopenHandled={onReopenHandled}
                onStatusChange={setExportStatus}
            />
        </>
    );
}
