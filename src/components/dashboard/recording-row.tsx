"use client";

import {
    Download,
    Folder,
    FolderInput,
    FolderPlus,
    Loader2,
    Mail,
    MoreHorizontal,
    Paperclip,
    Play,
    Share2,
    Trash2,
    UserPlus,
} from "lucide-react";
import { useExtracted, useLocale } from "next-intl";
import { type ReactNode, useState } from "react";
import { useConfirm } from "@/components/confirm-dialog";
import { MailDeleteDialog } from "@/components/recordings/erase-recording-menu";
import { FolderPicker } from "@/components/recordings/folder-picker";
import {
    changeShare,
    PersonShareDialog,
    usePersonSharing,
    usePersonSharingRefresh,
} from "@/components/sharing/person-sharing";
import { Button } from "@/components/ui/button";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useFolderLabel } from "@/hooks/use-folder-label";
import {
    RECORDING_DRAG_TYPE,
    RECORDING_OTHER_OWNER_DRAG_TYPE,
    RECORDING_SOURCE_FOLDER_DRAG_TYPE,
    RECORDING_SOURCE_SCOPE_DRAG_TYPES,
} from "@/lib/folders/drag";
import { formatDateTime } from "@/lib/format-date";
import { formatDurationMs } from "@/lib/format-duration";
import { recordingAudioDownloadPath } from "@/lib/recordings/filename";
import { cn } from "@/lib/utils";
import type { DateTimeFormat } from "@/types/common";
import type { RecordingFolder } from "@/types/folder";
import type { Recording } from "@/types/recording";

function folderTone(folder: RecordingFolder): string {
    return folder.scope === "org" ? "text-organization" : "text-primary";
}

export function RecordingRow({
    recording,
    isSelected,
    inFlight,
    snippet,
    isCompact,
    rowPadding,
    dateTimeFormat,
    onSelect,
    onDelete,
    shared = false,
    registerRef,
    folderLocations = [],
    firstFolder,
    sourceFolder,
    folders = [],
    assignedIds = new Set(),
    canCurate,
    isOrgAccount = false,
    onFolderCreated,
    onAssignRecording,
    onMoveRecording,
}: {
    recording: Recording;
    isSelected: boolean;
    inFlight: "transcribing" | "summarizing" | undefined;
    snippet: string | null;
    isCompact: boolean;
    rowPadding: string;
    dateTimeFormat: DateTimeFormat;
    onSelect: (recording: Recording) => void;
    onDelete: (recording: Recording) => Promise<void>;
    shared?: boolean;
    registerRef: (id: string, el: HTMLButtonElement | null) => void;
    folderLocations?: RecordingFolder[];
    firstFolder?: { folder: RecordingFolder; path: string };
    sourceFolder?: RecordingFolder | null;
    folders?: RecordingFolder[];
    assignedIds?: ReadonlySet<string>;
    canCurate?: boolean;
    isOrgAccount?: boolean;
    onFolderCreated?: (folder: RecordingFolder) => void;
    onAssignRecording?: (
        recordingId: string,
        folderId: string,
    ) => Promise<void>;
    onMoveRecording?: (
        recordingId: string,
        from: string,
        to: string,
    ) => Promise<void>;
}) {
    const i18n = useExtracted();
    const locale = useLocale();
    const confirm = useConfirm();
    const personSharing = usePersonSharing();
    const refresh = usePersonSharingRefresh();
    const [shareOpen, setShareOpen] = useState(false);
    const [removed, setRemoved] = useState(false);
    const received = recording.view === "received";
    const label = useFolderLabel();
    const [pickerOpen, setPickerOpen] = useState(false);
    const source =
        sourceFolder?.kind === "custom"
            ? (folderLocations.find(
                  (folder) => folder.id === sourceFolder?.id,
              ) ?? folderLocations[0])
            : null;
    const subfolders = folderLocations.filter(
        (folder) => folder.id !== sourceFolder?.id && folder.kind === "custom",
    );
    const showFirstFolder =
        firstFolder &&
        firstFolder.folder.id !== sourceFolder?.id &&
        !subfolders.some((folder) => folder.id === firstFolder.folder.id);
    const sharedBy =
        (recording.view === "org" || received) && recording.ownerName
            ? recording.isOwn
                ? i18n("Shared by you")
                : i18n("Shared by {owner}", { owner: recording.ownerName })
            : null;
    const [mailDeleteOpen, setMailDeleteOpen] = useState(false);
    let meta: ReactNode = null;
    if (snippet || recording.kind === "mail") {
        meta = (
            <span className="min-w-0 flex-1 truncate">
                {snippet ?? recording.mail?.from ?? i18n("Unknown sender")}
            </span>
        );
    } else if (showFirstFolder) {
        meta = (
            <span
                className="flex min-w-0 flex-1 items-center gap-1"
                title={firstFolder.path}
            >
                <Folder
                    className={cn(
                        "size-3 shrink-0",
                        folderTone(firstFolder.folder),
                    )}
                    aria-hidden="true"
                />
                <span className="truncate">{label(firstFolder.folder)}</span>
            </span>
        );
    }
    if (removed) return null;
    return (
        <div
            className={cn(
                "group/row relative",
                isSelected
                    ? "bg-accent shadow-[inset_2px_0_0_0_var(--color-primary)]"
                    : null,
            )}
        >
            <button
                ref={(el) => {
                    registerRef(recording.id, el);
                }}
                type="button"
                draggable={!!onAssignRecording && !received}
                onDragStart={(event) => {
                    if (recording.isOwn === false)
                        event.dataTransfer.setData(
                            RECORDING_OTHER_OWNER_DRAG_TYPE,
                            "true",
                        );
                    event.dataTransfer.setData(
                        RECORDING_DRAG_TYPE,
                        recording.id,
                    );
                    if (source) {
                        event.dataTransfer.setData(
                            RECORDING_SOURCE_FOLDER_DRAG_TYPE,
                            source.id,
                        );
                        event.dataTransfer.setData(
                            RECORDING_SOURCE_SCOPE_DRAG_TYPES[source.scope],
                            source.scope,
                        );
                    }
                    event.dataTransfer.effectAllowed = source
                        ? "copyMove"
                        : "copy";
                }}
                onClick={() => onSelect(recording)}
                className={cn(
                    "w-full text-left transition-colors hover:bg-accent/60",
                    rowPadding,
                )}
            >
                <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                        {recording.kind === "mail" && (
                            <Mail
                                className="size-3.5 shrink-0 text-primary"
                                aria-label={i18n("Mail")}
                            />
                        )}
                        <h3 className="truncate text-sm font-medium">
                            {recording.filename ||
                                (recording.kind === "mail"
                                    ? i18n("(no subject)")
                                    : "")}
                        </h3>
                        {recording.mail?.hasAttachments && (
                            <Paperclip
                                className="size-3 shrink-0 text-muted-foreground"
                                aria-label={i18n("Attachments")}
                            />
                        )}
                        {recording.mail?.waitingToShare && (
                            <Share2
                                className="size-3 shrink-0 text-organization"
                                aria-label={i18n("Waiting to be shared")}
                            />
                        )}
                        {inFlight && (
                            <span className="ml-auto inline-flex shrink-0 items-center gap-1 text-[11px] text-primary">
                                <Loader2
                                    className="size-3 animate-spin"
                                    aria-hidden="true"
                                />
                                {inFlight === "transcribing"
                                    ? i18n("Transcribing")
                                    : i18n("Summarizing")}
                            </span>
                        )}
                    </div>
                    {(subfolders.length > 0 || sharedBy) && (
                        <p className="mt-0.5 flex items-center gap-1 truncate text-xs text-muted-foreground">
                            {subfolders.length > 0 && (
                                <>
                                    <Folder
                                        className={cn(
                                            "size-3 shrink-0",
                                            folderTone(subfolders[0]),
                                        )}
                                    />
                                    <span className="truncate">
                                        {subfolders.map(label).join(", ")}
                                    </span>
                                </>
                            )}
                            {subfolders.length > 0 && sharedBy && (
                                <span>·</span>
                            )}
                            {sharedBy && (
                                <span
                                    className={cn(
                                        "truncate",
                                        received && "text-person-share",
                                    )}
                                >
                                    {sharedBy}
                                </span>
                            )}
                        </p>
                    )}
                    <div
                        className={cn(
                            "flex items-center gap-2 text-xs text-muted-foreground",
                            isCompact ? "mt-0.5" : "mt-1",
                        )}
                    >
                        {meta}
                        <span className="shrink-0 text-[11px]">
                            {recording.kind !== "mail" && (
                                <>{formatDurationMs(recording.duration)} · </>
                            )}
                            {formatDateTime(
                                recording.startTime,
                                dateTimeFormat,
                                locale,
                            )}
                        </span>
                    </div>
                </div>
            </button>
            <div className="absolute right-2 top-1/2 -translate-y-1/2 opacity-0 transition-opacity group-hover/row:opacity-100 focus-within:opacity-100 has-[[data-state=open]]:opacity-100">
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={i18n("Row actions")}
                            onClick={(e) => e.stopPropagation()}
                        >
                            <MoreHorizontal className="size-4" />
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                        <DropdownMenuItem onSelect={() => onSelect(recording)}>
                            <Play /> {i18n("Open")}
                        </DropdownMenuItem>
                        {personSharing &&
                            recording.isOwn !== false &&
                            !shared &&
                            recording.view !== "org" && (
                                <DropdownMenuItem
                                    onSelect={() => setShareOpen(true)}
                                >
                                    <UserPlus className="text-person-share" />
                                    {i18n("Share…")}
                                </DropdownMenuItem>
                            )}
                        {received && recording.receivedShare && (
                            <DropdownMenuItem
                                variant="destructive"
                                onSelect={() => {
                                    const share = recording.receivedShare;
                                    if (!share) return;
                                    void confirm({
                                        title: i18n("Remove and end sharing?"),
                                        description: i18n(
                                            "You will lose access to this item. The owner's item is kept.",
                                        ),
                                        confirmLabel: i18n(
                                            "Remove and end sharing",
                                        ),
                                        destructive: true,
                                        onConfirm: async () => {
                                            setRemoved(true);
                                            try {
                                                await changeShare(
                                                    share.id,
                                                    share.version,
                                                    "remove",
                                                );
                                                refresh();
                                            } catch (error) {
                                                setRemoved(false);
                                                throw error;
                                            }
                                        },
                                    });
                                }}
                            >
                                <Trash2 />
                                {i18n("Remove and end sharing")}
                            </DropdownMenuItem>
                        )}
                        {onAssignRecording && (
                            <DropdownMenuItem
                                onSelect={() => setPickerOpen(true)}
                            >
                                {source ? <FolderInput /> : <FolderPlus />}
                                {source
                                    ? i18n("Move to…")
                                    : i18n("Add to folder")}
                            </DropdownMenuItem>
                        )}
                        {!recording.audioReaped &&
                            (recording.kind !== "mail" ||
                                recording.isOwn !== false) && (
                                <DropdownMenuItem
                                    onSelect={() => {
                                        window.location.assign(
                                            recording.kind === "mail"
                                                ? `/api/mail/${encodeURIComponent(recording.id)}/raw`
                                                : recordingAudioDownloadPath(
                                                      recording.id,
                                                  ),
                                        );
                                    }}
                                >
                                    <Download />{" "}
                                    {recording.kind === "mail"
                                        ? i18n("Download the message")
                                        : i18n("Download audio")}
                                </DropdownMenuItem>
                            )}
                        {recording.isOwn !== false &&
                            (recording.view !== "org" || isOrgAccount) && (
                                <>
                                    <DropdownMenuSeparator />
                                    <DropdownMenuItem
                                        variant="destructive"
                                        onSelect={(e) => {
                                            e.preventDefault();
                                            if (recording.kind === "mail") {
                                                setMailDeleteOpen(true);
                                                return;
                                            }
                                            void confirm({
                                                title: i18n(
                                                    "Delete this recording?",
                                                ),
                                                description: (
                                                    <>
                                                        <span className="font-medium text-foreground">
                                                            {recording.filename}
                                                        </span>
                                                        <br />{" "}
                                                        {shared && (
                                                            <p>
                                                                {i18n(
                                                                    "This recording is shared with the Organization. It will be taken out of the Organization first, and colleagues will no longer see it.",
                                                                )}
                                                            </p>
                                                        )}
                                                        {i18n(
                                                            "The audio file and any transcript or summary will be removed. If the file is still on your Plaud device, the next sync will re-download it.",
                                                        )}
                                                    </>
                                                ),
                                                confirmLabel: i18n("Delete"),
                                                pendingLabel: i18n("Deleting…"),
                                                destructive: true,
                                                onConfirm: () =>
                                                    onDelete(recording),
                                            });
                                        }}
                                    >
                                        <Trash2 />
                                        {recording.kind === "mail"
                                            ? i18n("Delete mail")
                                            : i18n("Delete")}
                                    </DropdownMenuItem>
                                </>
                            )}
                    </DropdownMenuContent>
                </DropdownMenu>
            </div>
            {onAssignRecording && pickerOpen && (
                <FolderPicker
                    folders={folders}
                    canCurate={canCurate}
                    onCreated={onFolderCreated}
                    assignedIds={assignedIds}
                    open={pickerOpen}
                    onOpenChange={setPickerOpen}
                    organizationOnly={recording.isOwn === false && !received}
                    scope={received ? "personal" : source?.scope}
                    onSelect={async (folderId) => {
                        if (received && recording.receivedShare) {
                            await changeShare(
                                recording.receivedShare.id,
                                recording.receivedShare.version,
                                "file",
                                folderId,
                            );
                            refresh();
                            return;
                        }
                        return source && onMoveRecording
                            ? onMoveRecording(recording.id, source.id, folderId)
                            : onAssignRecording(recording.id, folderId);
                    }}
                />
            )}
            {personSharing && (
                <PersonShareDialog
                    itemId={recording.id}
                    title={recording.filename}
                    kind={recording.kind ?? "audio"}
                    open={shareOpen}
                    onOpenChange={setShareOpen}
                />
            )}
            {recording.kind === "mail" && (
                <MailDeleteDialog
                    mail={recording}
                    shared={shared}
                    open={mailDeleteOpen}
                    onOpenChange={setMailDeleteOpen}
                    onDelete={onDelete}
                />
            )}
        </div>
    );
}
