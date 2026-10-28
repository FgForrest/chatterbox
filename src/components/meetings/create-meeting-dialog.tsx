"use client";

import Link from "next/link";
import { useExtracted } from "next-intl";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useTimeZone } from "use-intl/react";
import { FolderCombobox } from "@/components/recordings/folder-combobox";
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
import { matchFolders } from "@/lib/folders/navigation";
import { dateTimeInputIso } from "@/lib/i18n/time-zone";
import type { RecordingFolder } from "@/types/folder";
import { meetingRequest } from "./api";
import { CalendarEventPicker } from "./calendar-event-picker";
import type { CalendarChoices, MeetingDetail } from "./types";

export function CreateMeetingDialog({
    folders,
    folderId,
    open,
    onOpenChange,
    onCreated,
    eventId,
}: {
    folders: RecordingFolder[];
    folderId?: string | null;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onCreated: (id: string, meeting?: MeetingDetail) => void;
    eventId?: string;
}) {
    const i18n = useExtracted();
    const timeZone = useTimeZone() ?? "UTC";
    const label = useFolderLabel();
    const available = folders.filter((folder) => folder.kind === "custom");
    const [chosenFolder, setChosenFolder] = useState(
        available.find((folder) => folder.id === folderId)?.id ?? "",
    );
    const [choices, setChoices] = useState<CalendarChoices | null>(null);
    const [manual, setManual] = useState(false);
    const [selected, setSelected] = useState(eventId ?? "");
    const [title, setTitle] = useState("");
    const [start, setStart] = useState("");
    const [end, setEnd] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const calendarError = i18n("Could not load calendar events");
    const hasDestination = available.some(
        (folder) => folder.id === chosenFolder,
    );
    useEffect(() => {
        if (!open || !hasDestination) return;
        const controller = new AbortController();
        setChoices(null);
        setError(null);
        void meetingRequest<CalendarChoices>(
            `/api/meetings/calendar-events?folderId=${encodeURIComponent(chosenFolder)}`,
            "GET",
            undefined,
            controller.signal,
        )
            .then((data) => {
                if (!controller.signal.aborted) {
                    setChoices(data);
                    if (data.reason) setManual(true);
                }
            })
            .catch(() => {
                if (!controller.signal.aborted) {
                    setManual(true);
                    setError(calendarError);
                }
            });
        return () => controller.abort();
    }, [open, chosenFolder, hasDestination, calendarError]);
    const events = [...(choices?.recurring ?? []), ...(choices?.other ?? [])];
    const chosenEvent = events.find((event) => event.id === selected);
    async function prepare() {
        if (chosenEvent?.visibleAgenda) {
            onCreated(chosenEvent.visibleAgenda.id);
            onOpenChange(false);
            return;
        }
        setBusy(true);
        try {
            const result = await meetingRequest<{
                id: string;
                meeting: MeetingDetail;
            }>("/api/meetings", "POST", {
                folderId: chosenFolder,
                ...(!manual && selected
                    ? { calendarEventId: selected }
                    : {
                          title: title.trim(),
                          ...(start
                              ? { start: dateTimeInputIso(start, timeZone) }
                              : {}),
                          ...(end
                              ? { end: dateTimeInputIso(end, timeZone) }
                              : {}),
                      }),
            });
            onCreated(result.id, result.meeting);
            onOpenChange(false);
        } catch {
            toast.error(i18n("Could not prepare the agenda"));
        } finally {
            setBusy(false);
        }
    }
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-xl">
                <DialogHeader>
                    <DialogTitle>{i18n("Prepare an agenda")}</DialogTitle>
                    <DialogDescription>
                        {manual
                            ? i18n("Without a calendar event")
                            : i18n("Choose an event, or continue without one.")}
                    </DialogDescription>
                </DialogHeader>
                <div className="grid gap-1 text-sm">
                    {i18n("Folder")}
                    <FolderCombobox
                        entries={matchFolders(folders, "", label).filter(
                            (entry) => entry.folder.kind === "custom",
                        )}
                        aria-label={i18n("Folder")}
                        value={chosenFolder}
                        onValueChange={(id) => {
                            setChosenFolder(id);
                            setSelected("");
                        }}
                    />
                </div>
                {!available.length && (
                    <p className="text-sm text-muted-foreground">
                        {i18n("Create a folder before preparing an agenda.")}
                    </p>
                )}
                {error && (
                    <p role="alert" className="text-sm">
                        {error}
                    </p>
                )}
                {!hasDestination ? (
                    <p className="text-sm text-muted-foreground">
                        {i18n("Choose a folder to prepare the agenda.")}
                    </p>
                ) : !manual ? (
                    <>
                        {!choices && !error && (
                            <output>{i18n("Loading calendar…")}</output>
                        )}
                        <CalendarEventPicker
                            choices={choices}
                            value={selected}
                            onValueChange={setSelected}
                            disabled={busy}
                        />
                        {choices && !events.length && (
                            <p className="text-sm text-muted-foreground">
                                {i18n(
                                    "No upcoming events in the next 14 days.",
                                )}
                            </p>
                        )}
                        <Button
                            variant="ghost"
                            className="justify-start"
                            onClick={() => setManual(true)}
                        >
                            {i18n("Without a calendar event…")}
                        </Button>
                        <p className="text-xs text-muted-foreground">
                            {i18n("You can choose an event later.")}
                        </p>
                    </>
                ) : (
                    <>
                        <label className="grid gap-1 text-sm">
                            {i18n("Title")}
                            <input
                                className="rounded-md border bg-background p-2"
                                value={title}
                                maxLength={500}
                                onChange={(event) =>
                                    setTitle(event.target.value)
                                }
                            />
                        </label>
                        <div className="grid gap-3 sm:grid-cols-2">
                            <label className="grid gap-1 text-sm">
                                {i18n("Start (optional)")}
                                <input
                                    type="datetime-local"
                                    className="min-w-0 rounded-md border bg-background p-2"
                                    value={start}
                                    onChange={(event) =>
                                        setStart(event.target.value)
                                    }
                                />
                            </label>
                            <label className="grid gap-1 text-sm">
                                {i18n("End (optional)")}
                                <input
                                    type="datetime-local"
                                    className="min-w-0 rounded-md border bg-background p-2"
                                    value={end}
                                    min={start || undefined}
                                    onChange={(event) =>
                                        setEnd(event.target.value)
                                    }
                                />
                            </label>
                        </div>
                        <p className="text-xs text-muted-foreground">
                            {i18n(
                                "Time is optional. Without it, the agenda works, but there is no timed reminder or automatic recording attachment.",
                            )}
                        </p>
                        {(choices?.reason === "not_connected" ||
                            choices?.reason === "no_calendar_scope") && (
                            <p className="text-xs text-muted-foreground">
                                <Link className="underline" href="/settings">
                                    {i18n(
                                        "Connect Google Calendar in Settings to see meetings and invitees.",
                                    )}
                                </Link>
                            </p>
                        )}
                        {choices && !choices.reason && (
                            <Button
                                variant="ghost"
                                onClick={() => setManual(false)}
                            >
                                {i18n("Back to calendar")}
                            </Button>
                        )}
                    </>
                )}
                <DialogFooter>
                    <Button
                        variant="outline"
                        onClick={() => onOpenChange(false)}
                    >
                        {i18n("Cancel")}
                    </Button>
                    <Button
                        disabled={
                            busy ||
                            !hasDestination ||
                            (manual
                                ? !title.trim() ||
                                  Boolean(end && (!start || end <= start)) ||
                                  Boolean(
                                      start &&
                                          !dateTimeInputIso(start, timeZone),
                                  ) ||
                                  Boolean(
                                      end && !dateTimeInputIso(end, timeZone),
                                  )
                                : !selected)
                        }
                        onClick={() => void prepare()}
                    >
                        {busy
                            ? i18n("Preparing…")
                            : chosenEvent?.visibleAgenda && !manual
                              ? i18n("Open agenda")
                              : i18n("Prepare")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
