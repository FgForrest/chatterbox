"use client";

import { Settings2 } from "lucide-react";
import { useExtracted } from "next-intl";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import type { Recording } from "@/types/recording";
import { meetingRequest } from "./api";
import type { CalendarChoices, MeetingDetail } from "./types";

function localTime(value: string | null) {
    if (!value) return "";
    const date = new Date(value);
    return new Date(date.getTime() - date.getTimezoneOffset() * 60000)
        .toISOString()
        .slice(0, 16);
}
export function MeetingSettings({
    detail,
    onSave,
    onDelete,
}: {
    detail: MeetingDetail;
    recordings?: Recording[];
    onSave: (
        change: {
            title: string;
            start: string | null;
            end: string | null;
            calendarEventId?: string | null;
        },
        optimistic: Partial<MeetingDetail>,
    ) => Promise<unknown>;
    onDelete: () => Promise<unknown>;
}) {
    const i18n = useExtracted();
    const [open, setOpen] = useState(false);
    const [title, setTitle] = useState(detail.title);
    const [start, setStart] = useState(localTime(detail.plannedStart));
    const [end, setEnd] = useState(localTime(detail.plannedEnd));
    const [eventId, setEventId] = useState(detail.calendarEventId ?? "");
    const [events, setEvents] = useState<CalendarChoices | null>(null);
    const [busy, setBusy] = useState(false);
    const [deleting, setDeleting] = useState(false);
    useEffect(() => {
        if (!open) return;
        setTitle(detail.title);
        setStart(localTime(detail.plannedStart));
        setEnd(localTime(detail.plannedEnd));
        setEventId(detail.calendarEventId ?? "");
        setDeleting(false);
        const controller = new AbortController();
        const folderId = detail.folders[0]?.id;
        if (folderId)
            void meetingRequest<CalendarChoices>(
                `/api/meetings/calendar-events?folderId=${encodeURIComponent(folderId)}`,
                "GET",
                undefined,
                controller.signal,
            )
                .then((result) => {
                    if (!controller.signal.aborted) setEvents(result);
                })
                .catch(() => {});
        return () => controller.abort();
    }, [open, detail]);
    return (
        <>
            <Button
                variant="ghost"
                size="icon-sm"
                aria-label={i18n("Meeting settings")}
                onClick={() => setOpen(true)}
            >
                <Settings2 className="size-4" />
            </Button>
            <Dialog open={open} onOpenChange={setOpen}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>{i18n("Meeting settings")}</DialogTitle>
                        <DialogDescription>
                            {i18n(
                                "Edit the title, time or linked calendar event.",
                            )}
                        </DialogDescription>
                    </DialogHeader>
                    <label className="grid gap-1 text-sm">
                        {i18n("Title")}
                        <input
                            value={title}
                            maxLength={500}
                            className="rounded border bg-background p-2"
                            onChange={(event) => setTitle(event.target.value)}
                        />
                    </label>
                    <label className="grid gap-1 text-sm">
                        {i18n("Start (optional)")}
                        <input
                            type="datetime-local"
                            value={start}
                            className="rounded border bg-background p-2"
                            onChange={(event) => setStart(event.target.value)}
                        />
                    </label>
                    <label className="grid gap-1 text-sm">
                        {i18n("End (optional)")}
                        <input
                            type="datetime-local"
                            value={end}
                            min={start || undefined}
                            className="rounded border bg-background p-2"
                            onChange={(event) => setEnd(event.target.value)}
                        />
                    </label>
                    {(detail.calendarEventId || (events && !events.reason)) && (
                        <label className="grid gap-1 text-sm">
                            {i18n("Calendar event")}
                            <select
                                value={eventId}
                                className="rounded border bg-background p-2"
                                onChange={(event) =>
                                    setEventId(event.target.value)
                                }
                            >
                                <option value="">
                                    {i18n("Without a calendar event")}
                                </option>
                                {detail.calendarEventId &&
                                    ![
                                        ...(events?.recurring ?? []),
                                        ...(events?.other ?? []),
                                    ].some(
                                        (event) =>
                                            event.id === detail.calendarEventId,
                                    ) && (
                                        <option value={detail.calendarEventId}>
                                            {detail.title}
                                        </option>
                                    )}
                                {[
                                    ...(events?.recurring ?? []),
                                    ...(events?.other ?? []),
                                ].map((event) => (
                                    <option
                                        key={event.id}
                                        value={event.id}
                                        disabled={Boolean(
                                            event.visibleAgenda &&
                                                event.visibleAgenda.id !==
                                                    detail.id,
                                        )}
                                    >
                                        {event.title}
                                    </option>
                                ))}
                            </select>
                        </label>
                    )}
                    {deleting && (
                        <p className="text-sm">
                            {i18n(
                                "Delete this meeting and its agenda? Actual task changes will remain.",
                            )}
                        </p>
                    )}
                    <DialogFooter>
                        <Button
                            variant="ghost"
                            disabled={busy}
                            onClick={() => {
                                if (!deleting) {
                                    setDeleting(true);
                                    return;
                                }
                                setBusy(true);
                                void onDelete().finally(() => {
                                    setBusy(false);
                                    setOpen(false);
                                });
                            }}
                        >
                            {deleting
                                ? i18n("Confirm deletion")
                                : i18n("Delete meeting")}
                        </Button>
                        <Button
                            variant="outline"
                            onClick={() => setOpen(false)}
                        >
                            {i18n("Cancel")}
                        </Button>
                        <Button
                            disabled={
                                busy ||
                                !title.trim() ||
                                Boolean(end && (!start || end <= start))
                            }
                            onClick={() => {
                                const plannedStart = start
                                    ? new Date(start).toISOString()
                                    : null;
                                const plannedEnd = end
                                    ? new Date(end).toISOString()
                                    : null;
                                setBusy(true);
                                void onSave(
                                    {
                                        title: title.trim(),
                                        start: plannedStart,
                                        end: plannedEnd,
                                        ...(eventId !==
                                        (detail.calendarEventId ?? "")
                                            ? {
                                                  calendarEventId:
                                                      eventId || null,
                                              }
                                            : {}),
                                    },
                                    {
                                        title: title.trim(),
                                        plannedStart,
                                        plannedEnd,
                                        timeSet: Boolean(start),
                                    },
                                ).finally(() => {
                                    setBusy(false);
                                    setOpen(false);
                                });
                            }}
                        >
                            {i18n("Save")}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </>
    );
}
