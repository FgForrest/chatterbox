"use client";

import { useExtracted, useFormatter } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import type { RecordingFolder } from "@/types/folder";
import type { Recording } from "@/types/recording";
import { meetingRequest, meetingUrl, recordingAudienceConflict } from "./api";
import type { MeetingDetail } from "./types";

export function AttachRecordingDialog({
    detail,
    recordings,
    folders,
    open,
    onOpenChange,
    onAttached,
}: {
    detail: MeetingDetail;
    recordings: Recording[];
    folders: RecordingFolder[];
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onAttached: (id: string) => void;
}) {
    const i18n = useExtracted();
    const format = useFormatter();
    const [selected, setSelected] = useState("");
    const [busy, setBusy] = useState(false);
    const [query, setQuery] = useState("");
    const [limit, setLimit] = useState(20);
    const start = Date.parse(detail.plannedStart ?? detail.createdAt);
    const sorted = [...recordings]
        .filter((recording) =>
            recording.filename
                .toLocaleLowerCase()
                .includes(query.toLocaleLowerCase()),
        )
        .sort(
            (a, b) =>
                Math.abs(Date.parse(a.startTime) - start) -
                Math.abs(Date.parse(b.startTime) - start),
        );
    async function attach() {
        setBusy(true);
        try {
            await meetingRequest(meetingUrl(detail.id, "/attach"), "POST", {
                recordingItemId: selected,
            });
            onAttached(selected);
            onOpenChange(false);
        } catch (error) {
            toast.error(
                recordingAudienceConflict(error)
                    ? i18n(
                          "This recording is shared with people who cannot see the agenda. Limit its sharing before attaching it.",
                      )
                    : i18n("Could not attach the recording"),
            );
        } finally {
            setBusy(false);
        }
    }
    const shared = detail.folders.some((folder) => {
        const visible = folders.find(
            (entry) =>
                entry.id === folder.id ||
                entry.receivedFolder?.sourceFolderId === folder.id,
        );
        return (
            visible?.scope === "org" ||
            visible?.sharedWithPeople ||
            visible?.receivedFolder
        );
    });
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-h-[85dvh] overflow-y-auto">
                <DialogHeader>
                    <DialogTitle>{i18n("Attach recording")}</DialogTitle>
                    <DialogDescription>
                        {i18n(
                            "Only your recordings are offered, nearest to the meeting time first.",
                        )}
                    </DialogDescription>
                </DialogHeader>
                <input
                    aria-label={i18n("Search recordings")}
                    placeholder={i18n("Search recordings")}
                    className="rounded border bg-background p-2"
                    value={query}
                    onChange={(event) => {
                        setQuery(event.target.value);
                        setLimit(20);
                    }}
                />
                <fieldset className="space-y-2">
                    <legend className="sr-only">{i18n("Recording")}</legend>
                    {sorted.slice(0, limit).map((recording) => (
                        <label
                            key={recording.id}
                            className="flex cursor-pointer items-start gap-3 rounded-lg border p-3 has-[:checked]:border-primary"
                        >
                            <input
                                type="radio"
                                name="attach-recording"
                                checked={selected === recording.id}
                                onChange={() => setSelected(recording.id)}
                                className="mt-1 accent-primary"
                            />
                            <span className="min-w-0">
                                <span className="block text-sm font-medium">
                                    {recording.filename}
                                </span>
                                <span className="text-xs text-muted-foreground">
                                    {format.dateTime(
                                        new Date(recording.startTime),
                                        {
                                            dateStyle: "medium",
                                            timeStyle: "short",
                                        },
                                    )}{" "}
                                    ·{" "}
                                    {i18n("{minutes, number} min", {
                                        minutes: Math.round(
                                            recording.duration / 60000,
                                        ),
                                    })}
                                </span>
                            </span>
                        </label>
                    ))}
                </fieldset>
                {sorted.length > limit && (
                    <Button
                        variant="ghost"
                        onClick={() => setLimit((value) => value + 20)}
                    >
                        {i18n("Show more")}
                    </Button>
                )}
                {!sorted.length && (
                    <p className="text-sm text-muted-foreground">
                        {i18n("No recordings found")}
                    </p>
                )}
                <p className="text-xs text-muted-foreground">
                    {shared
                        ? i18n(
                              "Attaching files the recording into the agenda’s shared folder. Sharing follows the recording owner’s normal review and publication rules.",
                          )
                        : i18n(
                              "Attaching files the recording into the agenda’s folder.",
                          )}
                </p>
                <Button
                    variant="ghost"
                    onClick={() => {
                        window.dispatchEvent(
                            new CustomEvent("meeting-upload", {
                                detail: {
                                    agendaId: detail.id,
                                    folderId:
                                        folders.find(
                                            (folder) =>
                                                folder.receivedFolder
                                                    ?.sourceFolderId ===
                                                detail.folders[0]?.id,
                                        )?.id ?? detail.folders[0]?.id,
                                },
                            }),
                        );
                        onOpenChange(false);
                    }}
                >
                    {i18n("Upload a file…")}
                </Button>
                <DialogFooter>
                    <Button
                        variant="outline"
                        onClick={() => onOpenChange(false)}
                    >
                        {i18n("Cancel")}
                    </Button>
                    <Button
                        disabled={!selected || busy}
                        onClick={() => void attach()}
                    >
                        {busy ? i18n("Attaching…") : i18n("Attach")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
