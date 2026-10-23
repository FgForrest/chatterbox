"use client";

import { FolderInput, FolderPlus, Trash2 } from "lucide-react";
import { useExtracted } from "next-intl";
import { type ComponentProps, useMemo, useRef, useState } from "react";
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
import { NativeSelect } from "@/components/ui/native-select";
import { useFolderLabel } from "@/hooks/use-folder-label";
import type { ExportProvidersAvailability } from "@/lib/folder-exports/types";
import { canManageOrganization } from "@/lib/folders/drag";
import {
    ancestorFolderIds,
    descendantFolderIds,
} from "@/lib/folders/hierarchy";
import { joinFolderPath, matchFolders } from "@/lib/folders/navigation";
import { canCreateSubfolder } from "@/lib/folders/permissions";
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
    onCreate,
    onMove,
    onDelete,
    exportProviders,
    mailEnabled = false,
    canCurate = false,
    isOrgAccount = false,
    initialAction,
    reopenExport,
    onReopenHandled,
}: {
    folder: RecordingFolder;
    folders: RecordingFolder[];
    count: number;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onRename: (id: string, name: string) => Promise<void>;
    onCreate: (parentId: string, name: string) => Promise<void>;
    onMove: (id: string, parentId: string) => Promise<void>;
    onDelete: (id: string) => Promise<void>;
    exportProviders: ExportProvidersAvailability;
    mailEnabled?: boolean;
    canCurate?: boolean;
    isOrgAccount?: boolean;
    initialAction?: "create";
    reopenExport?: "form" | "list";
    onReopenHandled?: () => void;
}) {
    const i18n = useExtracted();
    const sharingEnabled = usePersonSharing();
    const label = useFolderLabel();
    const confirm = useConfirm();
    const [name, setName] = useState(folder.name);
    const [renaming, setRenaming] = useState(false);
    const [creating, setCreating] = useState(initialAction === "create");
    const [moving, setMoving] = useState(false);
    const [exportStatus, setExportStatus] = useState<FolderExportStatus>({
        configured: [],
        loading: true,
        failed: false,
        inheritedFolderId: null,
    });
    const exports = exportStatus.configured;
    const [subfolder, setSubfolder] = useState("");
    const subfolderInput = useRef<HTMLInputElement>(null);
    const [parentId, setParentId] = useState(folder.parentId ?? "");
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
    const managedExport = folder.scope === "org" && !isOrgAccount;
    const inheritedExportFolder = folders.find(
        (item) => item.id === exportStatus.inheritedFolderId,
    );
    const canCreate = canCreateSubfolder(folder, canCurate, isOrgAccount);
    const subtree = descendantFolderIds(folders, folder.id);
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
                    onOpenAutoFocus={(event) => {
                        event.preventDefault();
                        if (initialAction === "create")
                            subfolderInput.current?.focus();
                    }}
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
                                {managedExport
                                    ? i18n(
                                          "Managed by the Organization account",
                                      )
                                    : exportStatus.loading
                                      ? i18n("Loading…")
                                      : exportStatus.failed
                                        ? i18n("Could not load folder exports.")
                                        : exports.length
                                          ? exports
                                                .map((configuration) =>
                                                    configuration.googleDrive
                                                        ? i18n(
                                                              "Google Drive: {folder}",
                                                              {
                                                                  folder: configuration
                                                                      .googleDrive
                                                                      .rootFolderName,
                                                              },
                                                          )
                                                        : configuration.targetPath,
                                                )
                                                .join(", ")
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
                        {canManage && !managedExport && (
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
                    {canCreate && !creating && (
                        <Button
                            variant="outline"
                            onClick={() => setCreating(true)}
                        >
                            <FolderPlus className="size-4" />
                            {i18n("New subfolder")}
                        </Button>
                    )}
                    {canCreate && creating && (
                        <div className="flex items-center gap-2 border-t pt-3">
                            <Input
                                ref={subfolderInput}
                                aria-label={i18n("New subfolder name")}
                                placeholder={i18n("Folder name")}
                                maxLength={100}
                                value={subfolder}
                                onChange={(event) =>
                                    setSubfolder(event.target.value)
                                }
                                disabled={saving}
                            />
                            <Button
                                variant="outline"
                                disabled={saving || !subfolder.trim()}
                                onClick={() =>
                                    void save(async () => {
                                        await onCreate(
                                            folder.id,
                                            subfolder.trim(),
                                        );
                                        setSubfolder("");
                                        setCreating(false);
                                    })
                                }
                            >
                                <FolderPlus className="size-4" />
                                {i18n("New subfolder")}
                            </Button>
                        </div>
                    )}
                    {folder.kind === "custom" && canManage && (
                        <>
                            {!moving && (
                                <Button
                                    variant="outline"
                                    onClick={() => setMoving(true)}
                                >
                                    <FolderInput className="size-4" />
                                    {i18n("Move to…")}
                                </Button>
                            )}
                            {moving && (
                                <div className="flex items-center gap-2 border-t pt-3">
                                    <NativeSelect
                                        aria-label={i18n("Destination folder")}
                                        value={parentId}
                                        onChange={(event) =>
                                            setParentId(event.target.value)
                                        }
                                        className="min-w-0 flex-1"
                                    >
                                        {entries
                                            .filter(
                                                (entry) =>
                                                    !entry.folder
                                                        .receivedFolder &&
                                                    entry.folder.scope ===
                                                        folder.scope &&
                                                    !subtree.has(
                                                        entry.folder.id,
                                                    ),
                                            )
                                            .map((entry) => (
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
                                    <Button
                                        variant="outline"
                                        disabled={
                                            saving ||
                                            !parentId ||
                                            parentId === folder.parentId
                                        }
                                        onClick={() =>
                                            void save(() =>
                                                onMove(folder.id, parentId),
                                            )
                                        }
                                    >
                                        <FolderInput className="size-4" />
                                        {i18n("Move to…")}
                                    </Button>
                                </div>
                            )}
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
                        </>
                    )}
                </DialogContent>
            </Dialog>
            <FolderExportActions
                folder={folder}
                providers={exportProviders}
                privateTree={privateTree && !managedExport}
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
