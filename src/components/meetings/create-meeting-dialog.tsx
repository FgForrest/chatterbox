"use client";

import { CalendarClock } from "lucide-react";
import Link from "next/link";
import { useExtracted, useFormatter } from "next-intl";
import { useEffect, useState } from "react";
import { toast } from "sonner";
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
import type { RecordingFolder } from "@/types/folder";
import { meetingRequest } from "./api";
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
    const format = useFormatter();
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
                              ? { start: new Date(start).toISOString() }
                              : {}),
                          ...(end ? { end: new Date(end).toISOString() } : {}),
                      }),
            });
            onCreated(result.id, result.meeting);
            onOpenChange(false);
        } catch {
            toast.error(i18n("Could not prepare the meeting"));
        } finally {
            setBusy(false);
        }
    }
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-xl">
                <DialogHeader>
                    <DialogTitle>{i18n("Prepare a meeting")}</DialogTitle>
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
                        {i18n("Create a folder before preparing a meeting.")}
                    </p>
                )}
                {error && (
                    <p role="alert" className="text-sm">
                        {error}
                    </p>
                )}
                {!hasDestination ? (
                    <p className="text-sm text-muted-foreground">
                        {i18n("Choose a folder to prepare the meeting.")}
                    </p>
                ) : !manual ? (
                    <>
                        {!choices && !error && (
                            <output>{i18n("Loading calendar…")}</output>
                        )}
                        {[
                            {
                                title: i18n(
                                    "Recurring meetings recorded in this folder",
                                ),
                                events: choices?.recurring ?? [],
                            },
                            {
                                title: i18n("Other calendar events"),
                                events: choices?.other ?? [],
                            },
                        ].map(
                            (group) =>
                                group.events.length > 0 && (
                                    <fieldset
                                        key={group.title}
                                        className="space-y-2"
                                    >
                                        <legend className="mb-2 text-xs font-semibold text-muted-foreground">
                                            {group.title}
                                        </legend>
                                        {group.events.map((event) => (
                                            <label
                                                key={event.id}
                                                className="flex cursor-pointer items-start gap-3 rounded-lg border p-3 has-[:checked]:border-primary has-[:checked]:bg-primary/5"
                                            >
                                                <input
                                                    type="radio"
                                                    name="meeting-event"
                                                    className="mt-1 accent-primary"
                                                    checked={
                                                        selected === event.id
                                                    }
                                                    onChange={() =>
                                                        setSelected(event.id)
                                                    }
                                                />
                                                <CalendarClock className="mt-0.5 size-4 shrink-0 text-meeting" />
                                                <span className="min-w-0 space-y-1">
                                                    <span className="block text-sm font-medium">
                                                        {event.title}
                                                    </span>
                                                    <span className="block text-xs text-muted-foreground">
                                                        {format.dateTime(
                                                            new Date(
                                                                event.start,
                                                            ),
                                                            {
                                                                dateStyle:
                                                                    "medium",
                                                                timeStyle:
                                                                    "short",
                                                            },
                                                        )}
                                                        –
                                                        {format.dateTime(
                                                            new Date(event.end),
                                                            {
                                                                timeStyle:
                                                                    "short",
                                                            },
                                                        )}
                                                    </span>
                                                    {event.recordingCount >
                                                        0 && (
                                                        <span className="block text-xs text-muted-foreground">
                                                            {i18n(
                                                                "{count, plural, one {# recording in this folder} other {# recordings in this folder}}",
                                                                {
                                                                    count: event.recordingCount,
                                                                },
                                                            )}
                                                        </span>
                                                    )}
                                                    <span className="block text-xs text-muted-foreground">
                                                        {i18n(
                                                            "{count, plural, one {# invitee} other {# invitees}}",
                                                            {
                                                                count: event
                                                                    .attendees
                                                                    .length,
                                                            },
                                                        )}
                                                    </span>
                                                    {event.visibleAgenda && (
                                                        <span className="block text-xs text-primary">
                                                            {i18n(
                                                                "Open agenda · Prepared by {author}",
                                                                {
                                                                    author:
                                                                        event
                                                                            .visibleAgenda
                                                                            .author
                                                                            .name ??
                                                                        i18n(
                                                                            "Unknown author",
                                                                        ),
                                                                },
                                                            )}
                                                        </span>
                                                    )}
                                                </span>
                                            </label>
                                        ))}
                                    </fieldset>
                                ),
                        )}
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
                                  Boolean(end && (!start || end <= start))
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
