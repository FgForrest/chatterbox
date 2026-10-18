"use client";

import {
    ChevronDown,
    CloudOff,
    FileAudio,
    FileText,
    FolderX,
    Loader2,
    RotateCcw,
    Sparkles,
    Trash2,
} from "lucide-react";
import { useExtracted } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { useProductName } from "@/components/product-name-provider";
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
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import type { Recording } from "@/types/recording";

type EraseOperation =
    | "audio"
    | "transcript"
    | "summary"
    | "learn"
    | "local"
    | "plaud"
    | "everywhere"
    | "restore-audio"
    | "mail-delete";

interface EraseRecordingMenuProps {
    recording: Recording;
    /**
     * In the Organization: the recording is the organization account's to
     * change, so erasing any of it takes it out of the Organization first.
     */
    shared?: boolean;
    onDeleteLocal?: (recording: Recording) => Promise<void>;
    onDeleteMail?: (mail: Recording) => Promise<void>;
    onChanged: () => void;
}

async function postOperation(
    recordingId: string,
    scope:
        | "audio"
        | "transcript"
        | "summary"
        | "learn"
        | "plaud"
        | "restore-audio",
    withdraw = false,
): Promise<void> {
    const response = await fetch(`/api/recordings/${recordingId}/erase`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(withdraw ? { scope, withdraw } : { scope }),
    });
    if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
            error?: string;
        } | null;
        throw new Error(body?.error || "Erase operation failed");
    }
}

export function MailDeleteDialog({
    mail,
    shared = false,
    open,
    onOpenChange,
    onDelete,
}: {
    mail: Recording;
    shared?: boolean;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onDelete: (mail: Recording) => Promise<void>;
}) {
    const i18n = useExtracted();
    const [working, setWorking] = useState(false);

    const execute = async () => {
        setWorking(true);
        try {
            await onDelete(mail);
            toast.success(i18n("Mail deleted."));
            onOpenChange(false);
        } catch (error) {
            toast.error(
                error instanceof Error
                    ? error.message
                    : i18n("The mail could not be deleted."),
            );
        } finally {
            setWorking(false);
        }
    };

    return (
        <Dialog
            open={open}
            onOpenChange={(next) => {
                if (!working) onOpenChange(next);
            }}
        >
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{i18n("Delete this mail?")}</DialogTitle>
                    <DialogDescription>
                        {i18n(
                            "The message, its attachments and anything made from it are removed for good.",
                        )}
                    </DialogDescription>
                </DialogHeader>
                {shared && (
                    <p className="text-sm font-medium">
                        {i18n(
                            "This mail is shared with the Organization. It will leave the Organization first, and colleagues will no longer see it.",
                        )}
                    </p>
                )}
                <DialogFooter>
                    <Button
                        variant="outline"
                        onClick={() => onOpenChange(false)}
                        disabled={working}
                    >
                        {i18n("Cancel")}
                    </Button>
                    <Button
                        variant="destructive"
                        onClick={() => void execute()}
                        disabled={working}
                    >
                        {working && <Loader2 className="size-4 animate-spin" />}
                        {i18n("Delete mail")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

export function ItemEraseMenu({
    recording,
    shared = false,
    onDeleteLocal,
    onDeleteMail,
    onChanged,
}: EraseRecordingMenuProps) {
    const i18n = useExtracted();
    const name = useProductName();
    const [operation, setOperation] = useState<EraseOperation | null>(null);
    const [confirmText, setConfirmText] = useState("");
    const [working, setWorking] = useState(false);
    const isMail = recording.kind === "mail";
    const isPlaudRecording = recording.deviceSn !== "local";
    const operationCopy: Record<
        Exclude<EraseOperation, "restore-audio">,
        { title: string; description: string; action: string; success: string }
    > = {
        audio: {
            title: i18n("Erase local audio for this recording?"),
            description: i18n(
                "Only the locally stored audio for the selected recording will be removed. Its transcripts and summaries stay available, and all other recordings remain unchanged. {name} will not download this audio again automatically.",
                { name },
            ),
            action: i18n("Erase audio"),
            success: i18n("Local audio erased"),
        },
        transcript: {
            title: i18n("Erase all transcripts for this recording?"),
            description: i18n(
                "All Plaud and custom transcripts, speaker assignments, and exported transcript files for the selected recording will be removed. Its existing summaries and all other recordings remain unchanged.",
            ),
            action: i18n("Erase transcripts"),
            success: i18n("Transcripts erased"),
        },
        summary: {
            title: isMail
                ? i18n("Erase this mail's summary?")
                : i18n("Erase all summaries for this recording?"),
            description: isMail
                ? i18n(
                      "The generated summary and tasks derived only from it will be removed. The message stays available. You can summarize it again manually.",
                  )
                : i18n(
                      "All Plaud and custom summaries and exported summary files for the selected recording will be removed. Its transcripts and all other recordings remain unchanged.",
                  ),
            action: isMail ? i18n("Erase summary") : i18n("Erase summaries"),
            success: isMail ? i18n("Summary erased") : i18n("Summaries erased"),
        },
        learn: {
            title: i18n("Erase Learn results for this item?"),
            description: i18n(
                "Removes what Learn found in this item and its review history. What you already added to the Almanac stays.",
            ),
            action: i18n("Erase Learn results"),
            success: i18n("Learn results erased"),
        },
        local: {
            title: i18n("Delete all local data for this recording?"),
            description: i18n(
                "All data stored by {name} for the selected recording will be removed: audio, transcripts, summaries, metadata, speaker assignments, and exported files. All other recordings remain unchanged. The Plaud original stays in your account and will not be synced back automatically.",
                { name },
            ),
            action: i18n("Delete all local data"),
            success: i18n("All local data deleted"),
        },
        plaud: {
            title: i18n("Move this recording's Plaud original to Trash?"),
            description: i18n(
                "Only the Plaud original for the selected recording will be moved to Trash. Its local {name} data and all other recordings remain unchanged. Plaud requires a separate action in its Trash to delete the recording permanently.",
                { name },
            ),
            action: i18n("Move Plaud original to Trash"),
            success: i18n("Moved Plaud original to Trash"),
        },
        everywhere: {
            title: i18n("Delete this recording everywhere?"),
            description: i18n(
                "Only the selected recording will be affected. Its Plaud original will be moved to Trash, then all of its local data and exported files will be removed from {name}. All other recordings remain unchanged. This cannot be undone from {name}.",
                { name },
            ),
            action: i18n("Delete everywhere"),
            success: i18n("Recording deleted everywhere"),
        },
        "mail-delete": {
            title: i18n("Delete this mail?"),
            description: i18n(
                "The message, its attachments and anything made from it are removed for good.",
            ),
            action: i18n("Delete mail"),
            success: i18n("Mail deleted."),
        },
    };

    const selectOperation = (next: EraseOperation) => {
        setConfirmText("");
        setOperation(next);
    };

    const restoreAudio = async () => {
        setWorking(true);
        try {
            await postOperation(recording.id, "restore-audio");
            toast.success(i18n("Audio restored from Plaud"));
            onChanged();
        } catch (error) {
            toast.error(
                error instanceof Error
                    ? error.message
                    : i18n("Audio restore failed"),
            );
        } finally {
            setWorking(false);
        }
    };

    const execute = async () => {
        if (
            !operation ||
            operation === "restore-audio" ||
            operation === "mail-delete"
        ) {
            return;
        }
        setWorking(true);
        try {
            if (operation === "local") {
                if (!onDeleteLocal) return;
                await onDeleteLocal(recording);
            } else if (operation === "everywhere") {
                if (!onDeleteLocal) return;
                await postOperation(recording.id, "plaud");
                await onDeleteLocal(recording);
            } else {
                await postOperation(
                    recording.id,
                    operation,
                    shared && operation !== "plaud",
                );
                toast.success(operationCopy[operation].success);
                onChanged();
            }
            setOperation(null);
        } catch (error) {
            toast.error(
                error instanceof Error
                    ? error.message
                    : i18n("Erase operation failed"),
            );
        } finally {
            setWorking(false);
        }
    };

    const copy =
        operation &&
        operation !== "restore-audio" &&
        operation !== "mail-delete"
            ? operationCopy[operation]
            : null;
    const requiresTitle = operation === "everywhere";
    // Everything but the Plaud original is the recording itself.
    const withdraws =
        shared &&
        operation !== null &&
        operation !== "plaud" &&
        operation !== "restore-audio";
    // What the owner's retention will delete matters only for a recording
    // that stays: not one deleted outright.
    const keepsRecording =
        withdraws &&
        (operation === "audio" ||
            operation === "transcript" ||
            operation === "summary");
    const preview = useWithdrawPreview(keepsRecording ? recording.id : null);
    const confirmed = !requiresTitle || confirmText === recording.filename;

    return (
        <>
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <Button
                        variant="outline"
                        className="h-11 gap-2.5 rounded-lg px-4 text-muted-foreground hover:text-destructive"
                        disabled={working}
                        aria-label={
                            isMail
                                ? i18n("Erase mail artifacts")
                                : i18n("Erase recording artifacts")
                        }
                    >
                        {working ? (
                            <Loader2 className="size-4 animate-spin" />
                        ) : (
                            <Trash2 className="size-4" />
                        )}
                        <span className="hidden sm:inline">
                            {i18n("Erase")}
                        </span>
                        <ChevronDown className="hidden size-4 sm:block" />
                    </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-64">
                    {isMail ? (
                        <>
                            <DropdownMenuItem
                                disabled={recording.hasSummary === false}
                                onSelect={() => selectOperation("summary")}
                            >
                                <Sparkles className="size-4" />{" "}
                                {i18n("Erase summary")}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                                onSelect={() => selectOperation("learn")}
                            >
                                <FileText className="size-4" />{" "}
                                {i18n("Erase Learn results")}
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                                variant="destructive"
                                onSelect={() => selectOperation("mail-delete")}
                            >
                                <Trash2 className="size-4" />{" "}
                                {i18n("Delete mail")}
                            </DropdownMenuItem>
                        </>
                    ) : (
                        <>
                            <DropdownMenuLabel>
                                {i18n("Local artifacts")}
                            </DropdownMenuLabel>
                            {recording.audioReaped && isPlaudRecording ? (
                                <DropdownMenuItem
                                    // Shared, only the organization account changes it.
                                    disabled={shared}
                                    onSelect={() => void restoreAudio()}
                                >
                                    <RotateCcw className="size-4" />{" "}
                                    {i18n("Restore audio from Plaud")}
                                </DropdownMenuItem>
                            ) : (
                                <DropdownMenuItem
                                    disabled={recording.audioReaped}
                                    onSelect={() => selectOperation("audio")}
                                >
                                    <FileAudio className="size-4" />{" "}
                                    {i18n("Erase local audio")}
                                </DropdownMenuItem>
                            )}
                            <DropdownMenuItem
                                disabled={recording.hasTranscript === false}
                                onSelect={() => selectOperation("transcript")}
                            >
                                <FileText className="size-4" />{" "}
                                {i18n("Erase transcripts")}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                                disabled={recording.hasSummary === false}
                                onSelect={() => selectOperation("summary")}
                            >
                                <Sparkles className="size-4" />{" "}
                                {i18n("Erase summaries")}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                                onSelect={() => selectOperation("learn")}
                            >
                                <FileText className="size-4" />{" "}
                                {i18n("Erase Learn results")}
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                                onSelect={() => selectOperation("local")}
                            >
                                <FolderX className="size-4" />{" "}
                                {i18n("Delete all local data")}
                            </DropdownMenuItem>
                            {isPlaudRecording && (
                                <>
                                    <DropdownMenuItem
                                        onSelect={() =>
                                            selectOperation("plaud")
                                        }
                                    >
                                        <CloudOff className="size-4" />{" "}
                                        {i18n("Move Plaud original to Trash")}
                                    </DropdownMenuItem>
                                    <DropdownMenuSeparator />
                                    <DropdownMenuItem
                                        variant="destructive"
                                        onSelect={() =>
                                            selectOperation("everywhere")
                                        }
                                    >
                                        <Trash2 className="size-4" />{" "}
                                        {i18n("Delete everywhere")}
                                    </DropdownMenuItem>
                                </>
                            )}
                        </>
                    )}
                </DropdownMenuContent>
            </DropdownMenu>

            {isMail && onDeleteMail && (
                <MailDeleteDialog
                    mail={recording}
                    shared={shared}
                    open={operation === "mail-delete"}
                    onOpenChange={(open) => {
                        if (!open) setOperation(null);
                    }}
                    onDelete={async (mail) => {
                        await onDeleteMail(mail);
                        onChanged();
                    }}
                />
            )}

            <Dialog
                open={copy !== null}
                onOpenChange={(open) => {
                    if (!open && !working) setOperation(null);
                }}
            >
                <DialogContent>
                    {copy && (
                        <>
                            <DialogHeader>
                                <DialogTitle>{copy.title}</DialogTitle>
                                <DialogDescription>
                                    {copy.description}
                                </DialogDescription>
                            </DialogHeader>
                            {withdraws && (
                                <p className="text-sm font-medium">
                                    {isMail
                                        ? i18n(
                                              "This mail is shared with the Organization. It will leave the Organization first, and colleagues will no longer see it.",
                                          )
                                        : i18n(
                                              "This recording is shared with the Organization. It will be taken out of the Organization first, and colleagues will no longer see it.",
                                          )}
                                </p>
                            )}
                            {keepsRecording && (
                                <WithdrawRetentionWarning preview={preview} />
                            )}
                            {requiresTitle && (
                                <div className="space-y-2">
                                    <p className="text-sm text-muted-foreground">
                                        {i18n("Type")}{" "}
                                        <strong>{recording.filename}</strong>{" "}
                                        {i18n("to confirm.")}
                                    </p>
                                    <Input
                                        value={confirmText}
                                        onChange={(event) =>
                                            setConfirmText(event.target.value)
                                        }
                                        autoComplete="off"
                                        aria-label={i18n(
                                            "Recording title confirmation",
                                        )}
                                    />
                                </div>
                            )}
                            <DialogFooter>
                                <Button
                                    variant="outline"
                                    onClick={() => setOperation(null)}
                                    disabled={working}
                                >
                                    {i18n("Cancel")}
                                </Button>
                                <Button
                                    variant="destructive"
                                    onClick={() => void execute()}
                                    disabled={
                                        working ||
                                        !confirmed ||
                                        (keepsRecording &&
                                            preview.status === "loading")
                                    }
                                >
                                    {working && (
                                        <Loader2 className="size-4 animate-spin" />
                                    )}
                                    {copy.action}
                                </Button>
                            </DialogFooter>
                        </>
                    )}
                </DialogContent>
            </Dialog>
        </>
    );
}

export { ItemEraseMenu as EraseRecordingMenu };
