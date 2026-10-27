"use client";

import { Settings2 } from "lucide-react";
import { useExtracted } from "next-intl";
import { useEffect, useRef, useState } from "react";
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
            title?: string;
            start?: string | null;
            end?: string | null;
            calendarEventId?: string | null;
            previous: {
                title?: string;
                start?: string | null;
                end?: string | null;
                calendarEventId?: string | null;
            };
        },
        optimistic: Partial<MeetingDetail>,
    ) => Promise<boolean>;
    onDelete: () => Promise<boolean>;
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
    const latest = useRef(detail);
    latest.current = detail;
    const original = useRef(detail);
    const edited = useRef(new Set<string>());
    const [notice, setNotice] = useState(false);
    useEffect(() => {
        if (!open) return;
        const detail = latest.current;
        original.current = detail;
        edited.current.clear();
        setNotice(false);
        setEvents(null);
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
    }, [open]);
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
                            onChange={(event) => {
                                edited.current.add("title");
                                setTitle(event.target.value);
                            }}
                        />
                    </label>
                    <label className="grid gap-1 text-sm">
                        {i18n("Start (optional)")}
                        <input
                            type="datetime-local"
                            value={start}
                            className="rounded border bg-background p-2"
                            onChange={(event) => {
                                edited.current.add("start");
                                setStart(event.target.value);
                            }}
                        />
                    </label>
                    <label className="grid gap-1 text-sm">
                        {i18n("End (optional)")}
                        <input
                            type="datetime-local"
                            value={end}
                            min={start || undefined}
                            className="rounded border bg-background p-2"
                            onChange={(event) => {
                                edited.current.add("end");
                                setEnd(event.target.value);
                            }}
                        />
                    </label>
                    {(detail.calendarEventId || (events && !events.reason)) && (
                        <label className="grid gap-1 text-sm">
                            {i18n("Calendar event")}
                            <select
                                value={eventId}
                                className="rounded border bg-background p-2"
                                onChange={(event) => {
                                    edited.current.add("calendarEventId");
                                    setEventId(event.target.value);
                                }}
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
                    {notice && (
                        <p role="alert">
                            {i18n(
                                "Your changes were not saved. Your input is kept. Review the current meeting and try again.",
                            )}
                        </p>
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
                                void onDelete()
                                    .then((saved) => {
                                        if (saved) setOpen(false);
                                        else setNotice(true);
                                    })
                                    .finally(() => setBusy(false));
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
                                const before = notice
                                    ? latest.current
                                    : original.current;
                                const change = {
                                    ...(edited.current.has("title") &&
                                    title.trim() !== before.title
                                        ? { title: title.trim() }
                                        : {}),
                                    ...(edited.current.has("start") &&
                                    start !== localTime(before.plannedStart)
                                        ? { start: plannedStart }
                                        : {}),
                                    ...(edited.current.has("end") &&
                                    end !== localTime(before.plannedEnd)
                                        ? { end: plannedEnd }
                                        : {}),
                                    ...(edited.current.has("calendarEventId") &&
                                    eventId !== (before.calendarEventId ?? "")
                                        ? { calendarEventId: eventId || null }
                                        : {}),
                                };
                                const previous = {
                                    ...("title" in change
                                        ? { title: before.title }
                                        : {}),
                                    ...("start" in change
                                        ? { start: before.plannedStart }
                                        : {}),
                                    ...("end" in change
                                        ? { end: before.plannedEnd }
                                        : {}),
                                    ...("calendarEventId" in change
                                        ? {
                                              calendarEventId:
                                                  before.calendarEventId,
                                          }
                                        : {}),
                                };
                                if (!Object.keys(change).length) {
                                    setOpen(false);
                                    return;
                                }
                                setBusy(true);
                                void onSave(
                                    { ...change, previous },
                                    {
                                        ...("title" in change
                                            ? { title: title.trim() }
                                            : {}),
                                        ...("start" in change
                                            ? {
                                                  plannedStart,
                                                  timeSet: Boolean(start),
                                              }
                                            : {}),
                                        ...("end" in change
                                            ? { plannedEnd }
                                            : {}),
                                        ...("calendarEventId" in change
                                            ? {
                                                  calendarEventId:
                                                      eventId || null,
                                              }
                                            : {}),
                                    },
                                )
                                    .then((saved) => {
                                        if (saved) setOpen(false);
                                        else {
                                            setNotice(true);
                                        }
                                    })
                                    .finally(() => setBusy(false));
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
